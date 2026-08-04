/*!
 * teacher-agent-sandbox · 联网搜索模块 (web-search.js)
 * ------------------------------------------------------------------
 * 提供联网检索能力，供智能体核实课标、查最新教法、获取教学资源。
 * 改进：
 *   1) Electron 桌面环境：主进程原生 HTTP 请求，完全绕过 CORS 限制
 *   2) 智能关键词提取：不直接搜索用户的完整句子，而是提取核心关键词
 *   3) 搜索结果整合：自动抓取 Top N 网页内容并整合为摘要
 *   4) 参考资料返回：搜索结果的 URL 作为可点击的参考资料
 */
(function (global) {
  'use strict';

  var CACHE_KEY = 'teacher_agent_search_cache';
  var CACHE_MAX = 40;

  function _cache() {
    try { return JSON.parse(sessionStorage.getItem(CACHE_KEY) || '[]'); } catch (e) { return []; }
  }
  function _cachePut(query, results) {
    try {
      var c = _cache();
      c.unshift({ q: query, results: results, t: Date.now() });
      if (c.length > CACHE_MAX) c.length = CACHE_MAX;
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(c));
    } catch (e) { /* ignore */ }
  }
  function _cacheGet(query) {
    var c = _cache();
    var hit = c.find(function (x) { return x.q === query; });
    if (hit && Date.now() - hit.t < 30 * 60 * 1000) return hit.results;
    return null;
  }

  function _dedupe(results) {
    var seen = new Set(); var out = [];
    results.forEach(function (r) {
      var k = (r.url || r.title || '').toLowerCase();
      if (k && !seen.has(k)) { seen.add(k); out.push(r); }
    });
    return out;
  }

  /**
   * 统一 HTTP 获取（Electron 优先 → 直连 → CORS 代理兜底）
   * 返回 { ok, text } 或 { ok:false, error }
   * @param {string} url - 请求地址
   * @param {number} timeout - 超时毫秒
   * @param {Object} headers - 可选自定义请求头（如 API 认证）
   */
  async function _httpGet(url, timeout, headers, _redirectDepth) {
    timeout = timeout || 12000;
    _redirectDepth = _redirectDepth || 0;
    if (_redirectDepth > 5) return { ok: false, error: '重定向次数过多' };

    // 1) Electron 桌面环境：主进程原生请求，无 CORS 限制
    if (global.electronAPI && global.electronAPI.fetchUrl) {
      var nativeErr = '';
      try {
        var result = await global.electronAPI.fetchUrl(url, { timeout: timeout, headers: headers || null });
        if (result.ok && result.data) {
          // 处理重定向（带深度限制，防止重定向环路）
          if (result.data.redirect) {
            return await _httpGet(result.data.redirect, timeout, headers, _redirectDepth + 1);
          }
          if (result.data.content) {
            return { ok: true, text: result.data.content, source: 'electron-native' };
          }
        }
        nativeErr = (result && result.error) ? result.error : '请求未返回内容';
      } catch (e) {
        nativeErr = e.message || '请求异常';
      }
      // Electron 环境下原生请求是最可靠路径，失败后不再尝试第三方 CORS 代理
      // （桌面应用走外部代理既不可靠又会额外消耗 12s×3 的超时预算，是搜索频繁超时的重要诱因）
      return { ok: false, error: nativeErr };
    }

    // 2) 带自定义头的直连请求（部分 API 如 Bing Search 支持 CORS）
    if (headers) {
      try {
        var ctrl0 = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer0 = setTimeout(function () { if (ctrl0) ctrl0.abort(); }, timeout);
        var resp0 = await fetch(url, { signal: ctrl0 ? ctrl0.signal : undefined, headers: headers });
        clearTimeout(timer0);
        if (resp0 && resp0.ok) {
          var text0 = await resp0.text();
          if (text0) return { ok: true, text: text0, source: 'direct' };
        }
      } catch (e) { /* 降级到代理 */ }
    }

    // 3) CORS 代理（浏览器模式兜底）
    var proxies = [
      'https://api.allorigins.win/raw?url=',
      'https://corsproxy.io/?url=',
      'https://api.codetabs.com/v1/proxy/?quest=',
    ];
    for (var i = 0; i < proxies.length; i++) {
      try {
        var proxyUrl = proxies[i] + encodeURIComponent(url);
        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeout);
        var resp = await fetch(proxyUrl, { signal: ctrl ? ctrl.signal : undefined });
        clearTimeout(timer);
        if (resp && resp.ok) {
          var text = await resp.text();
          if (text && text.length > 50) {
            return { ok: true, text: text, source: 'cors-proxy' };
          }
        }
      } catch (e) { /* 尝试下一个代理 */ }
    }

    return { ok: false, error: '所有获取方式均失败' };
  }

  /**
   * 反爬拦截页检测
   * 搜索引擎在检测到异常请求时会返回验证码/安全验证页，此时 HTML 中无正常搜索结果。
   * 检测到拦截时返回错误描述，供调用方记录与降级。
   */
  function _detectAntiCrawl(html, engine) {
    if (!html) return null;
    var h = String(html);
    // 通用特征：页面过短且含验证类关键词
    if (h.length < 800) {
      if (/验证|verify|captcha|challenge|安全检测|access denied/i.test(h)) {
        return '搜索引擎返回验证页（疑似反爬拦截）';
      }
    }
    if (engine === 'baidu') {
      if (/wappass\.baidu\.com|百度安全验证|百度安全|访问验证|bdverify/i.test(h)) {
        return '百度安全验证页（反爬拦截）';
      }
    } else if (engine === 'bing') {
      if (/bCap|bing\.com\/secure|identity|verify|人力检查|teapot/i.test(h)) {
        return '必应验证页（反爬拦截）';
      }
    } else if (engine === 'sogou') {
      if (/sogou\/antispider|搜狗安全|用户你好|访问受限|频繁/i.test(h)) {
        return '搜狗反爬拦截页';
      }
    }
    return null;
  }

  /**
   * 通用链接提取兜底
   * 当引擎特定解析全部失败（HTML 结构变更）时，从 HTML 中提取所有有效外链作为结果。
   * 过滤掉搜索引擎自身链接、广告、跳转、javascript 等无效链接。
   */
  function _extractGenericLinks(html, engine) {
    var results = [];
    if (!html) return results;
    var h = String(html);
    var doc = null;
    if (typeof DOMParser !== 'undefined') {
      doc = new DOMParser().parseFromString(h, 'text/html');
    }
    var engineDomains = {
      baidu: ['baidu.com', 'baidu.cn', 'baidubcs.com'],
      bing: ['bing.com', 'microsoft.com', 'msn.com'],
      sogou: ['sogou.com', 'sogo.com'],
    };
    var blockDomains = engineDomains[engine] || [];
    blockDomains = blockDomains.concat(['google.com', 'facebook.com', 'twitter.com', 'javascript:void']);

    function _isBlocked(url) {
      var u = (url || '').toLowerCase();
      if (!u || u.indexOf('http') !== 0) return true;
      return blockDomains.some(function (d) { return u.indexOf(d) >= 0; });
    }

    function _processLink(link) {
      var href = link.getAttribute ? (link.getAttribute('href') || '') : '';
      if (_isBlocked(href)) return;
      var title = (link.textContent || '').trim();
      // 尝试从父元素获取更多文本作为摘要
      var parent = link.parentElement;
      var snippet = '';
      if (parent) {
        var sib = parent.nextElementSibling;
        if (sib) snippet = (sib.textContent || '').trim().slice(0, 200);
      }
      if (title.length >= 4) {
        results.push({ title: title, url: href, snippet: snippet, source: engine + '-generic' });
      }
    }

    if (doc) {
      // 优先提取 h2/h3 下的链接（搜索引擎结果标题通常是 h2/h3 > a）
      var headingLinks = doc.querySelectorAll('h2 a[href^="http"], h3 a[href^="http"]');
      headingLinks.forEach(_processLink);
      // 不够时补充所有外链
      if (results.length < 4) {
        var allLinks = doc.querySelectorAll('a[href^="http"]');
        allLinks.forEach(function (link) {
          if (results.length >= 10) return;
          _processLink(link);
        });
      }
    }
    // 正则兜底
    if (results.length === 0) {
      var regex = /<a[^>]*href="(https?:\/\/(?!.*(?:baidu\.com|bing\.com|sogou\.com|google\.com|facebook\.com))[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      var m;
      while ((m = regex.exec(h)) !== null && results.length < 10) {
        var title = m[2].replace(/<[^>]+>/g, '').trim();
        if (title.length >= 4) results.push({ title: title, url: m[1], snippet: '', source: engine + '-regex' });
      }
    }
    return results;
  }

  /**
   * 从 HTML 中提取搜索结果
   * 支持百度、必应、搜狗等搜索引擎结果页解析
   * 增强健壮性：多选择器兼容 + 反爬检测 + 通用链接兜底
   */
  function _parseSearchResults(html, engine) {
    var results = [];
    try {
      // 反爬拦截页检测：若被拦截则直接返回空（调用方会记录并尝试其他引擎）
      var antiCrawl = _detectAntiCrawl(html, engine);
      if (antiCrawl) {
        console.warn('[web-search] ' + engine + ' 反爬拦截: ' + antiCrawl);
        return results;
      }

      // 尝试用 DOMParser 解析（Electron 和现代浏览器都支持）
      var doc = null;
      if (typeof DOMParser !== 'undefined') {
        doc = new DOMParser().parseFromString(html, 'text/html');
      }

      if (engine === 'baidu') {
        // 百度搜索结果：兼容多种结构
        // 1) 经典：.result.c-container → h3 > a
        // 2) 新版：.result-op、[tpl="..."] 运营卡片
        // 3) 简化：.result（无 c-container）
        var items = doc ? doc.querySelectorAll('.result.c-container, .c-container, .result, .result-op') : [];
        if (items.length === 0) {
          // 降级：正则匹配 h3 > a
          var regex = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
          var m;
          while ((m = regex.exec(html)) !== null && results.length < 10) {
            var title = m[2].replace(/<[^>]+>/g, '').trim();
            if (title.length >= 4) results.push({ title: title, url: m[1], snippet: '', source: 'baidu' });
          }
        } else {
          items.forEach(function (item) {
            var link = item.querySelector('h3 a, .t a, a[href]');
            if (!link) return;
            var title = (link.textContent || '').trim();
            var href = link.getAttribute('href') || '';
            // 百度链接可能是跳转链接（baidu.com/link?url=...），保留原始由后续处理
            var snippet = '';
            var abs = item.querySelector('.c-abstract, [class*="abstract"], [class*="content"], .c-span-last');
            if (abs) snippet = (abs.textContent || '').trim().slice(0, 200);
            if (title.length >= 4 && href) results.push({ title: title, url: href, snippet: snippet, source: 'baidu' });
          });
        }
      } else if (engine === 'bing') {
        // 必应搜索结果：兼容多种结构
        // 1) 经典：.b_algo → h2 > a
        // 2) 新版：#b_results > li.b_algo、li.b_algoLead
        // 3) 国际版变体：.b_caption 容器
        var bingItems = doc ? doc.querySelectorAll('.b_algo, .b_algoLead, #b_results > li') : [];
        if (bingItems.length === 0) {
          var bingRegex = /<h2><a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/g;
          var bm;
          while ((bm = bingRegex.exec(html)) !== null && results.length < 10) {
            var bTitle = bm[2].replace(/<[^>]+>/g, '').trim();
            if (bTitle.length >= 4) results.push({ title: bTitle, url: bm[1], snippet: '', source: 'bing' });
          }
        } else {
          bingItems.forEach(function (item) {
            var link = item.querySelector('h2 a, h3 a, a.tilk, a[href^="http"]');
            if (!link) return;
            var title = (link.textContent || '').trim();
            var href = link.getAttribute('href') || '';
            var snippet = '';
            var cap = item.querySelector('.b_caption p, .b_paractl, .b_lineclamp');
            if (cap) snippet = (cap.textContent || '').trim().slice(0, 200);
            if (title.length >= 4 && href.indexOf('http') === 0) results.push({ title: title, url: href, snippet: snippet, source: 'bing' });
          });
        }
      } else if (engine === 'sogou') {
        // 搜狗搜索结果：兼容多种结构
        var sogouItems = doc ? doc.querySelectorAll('.vrwrap, .results > div, .rb, .news-box') : [];
        if (sogouItems.length === 0 && doc) {
          // 降级：直接查 h3 > a
          sogouItems = doc.querySelectorAll('h3 a[href]');
        }
        sogouItems.forEach(function (item) {
          var link = (item.querySelector) ? item.querySelector('h3 a, .vr-title a, a[href]') : item;
          if (!link) return;
          var title = (link.textContent || '').trim();
          var href = link.getAttribute ? (link.getAttribute('href') || '') : '';
          if (href && href.indexOf('http') !== 0) href = 'https://www.sogou.com' + href;
          var snippet = '';
          var ft = item.querySelector ? item.querySelector('.fz-mid, .str-text-info, .str_info, .ft') : null;
          if (ft) snippet = (ft.textContent || '').trim().slice(0, 200);
          if (title.length >= 4 && href) results.push({ title: title, url: href, snippet: snippet, source: 'sogou' });
        });
      }
    } catch (e) { /* 解析失败，返回已解析的部分 */ }

    // 通用兜底：若引擎特定解析返回空（HTML 结构变更），用通用链接提取兜底
    if (results.length === 0 && html) {
      results = _extractGenericLinks(html, engine);
    }
    return results;
  }

  /**
   * 从 HTML 提取纯文本正文
   */
  function _htmlToText(html, maxChars) {
    maxChars = maxChars || 4000;
    var text = String(html || '');
    // 移除脚本、样式、注释
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '');
    // 尝试提取正文内容
    var bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) text = bodyMatch[1];
    // 去标签
    text = text.replace(/<[^>]+>/g, '\n')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#\d+;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .split('\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length > 1; })
      .join('\n')
      .slice(0, maxChars);
    return text;
  }

  var WebSearch = {
    /**
     * 从完整查询中提取搜索关键词
     */
    _extractKeywords(query) {
      if (!query) return '';
      var q = String(query).trim();
      if (q.length <= 6) return q;
      var actionWords = [
        '请帮我', '帮我写', '帮我做', '帮我生成', '帮我制作',
        '生成一份', '制作一份', '写一份', '做一份',
        '生成一个', '制作一个', '写一个', '做一个',
        '生成', '制作', '创建', '设计', '规划', '编写',
        '帮我', '请', '需要', '想要', '帮我查', '查一下',
      ];
      actionWords.forEach(function (w) { q = q.replace(new RegExp(w, 'g'), ''); });
      q = q.replace(/(一份|一个|一些|点|关于|的)/g, '');
      q = q.replace(/[，。、！？；：""''（）【】《》\?,\.!\?;:\-\|]/g, ' ');
      q = q.replace(/\s+/g, ' ').trim();
      if (!q || q.length < 2) return query.trim();
      return q;
    },

    /**
     * 相关性打分：关键词命中（标题权重3、摘要权重1）+ 精确短语 + 域名质量
     */
    _scoreRelevance(result, queryTokens, queryPhrase) {
      var score = 0;
      var title = (result.title || '').toLowerCase();
      var snippet = (result.snippet || '').toLowerCase();
      var url = (result.url || '').toLowerCase();
      var combined = title + ' ' + snippet;
      // 关键词命中
      queryTokens.forEach(function (tok) {
        if (tok.length < 2) return;
        if (title.indexOf(tok) >= 0) score += 3;
        if (snippet.indexOf(tok) >= 0) score += 1;
        if (url.indexOf(tok) >= 0) score += 0.5;
      });
      // 精确短语匹配
      if (queryPhrase && queryPhrase.length >= 4) {
        if (title.indexOf(queryPhrase) >= 0) score += 5;
        if (snippet.indexOf(queryPhrase) >= 0) score += 2;
      }
      // 域名质量
      var domain = '';
      try { domain = new URL(result.url).hostname.replace('www.', ''); } catch (e) {}
      if (/\.edu\.cn$|\.edu$|\.ac\.cn$/.test(domain)) score += 3;
      var eduDomains = ['zxxk.com', '5ykj.com', '21cnjy.com', 'jtyhjy.com', 'pep.com.cn',
        'moe.gov.cn', 'cnki.net', 'wanfangdata.com', 'doc88.com', 'docin.com',
        'gaokao.com', 'zujuan.com', 'xueersi.com', 'yuanfudao.com', 'zybang.com',
        'jyeoo.com', 'cooco.net.cn', 'ks5u.com', 'gkstk.com', '51jiaoxue.com',
        'ruiwen.com', 'wenku.baidu.com', 'wenku.com', 'max.book118.com'];
      if (eduDomains.some(function (d) { return domain === d || domain.indexOf('.' + d) >= 0 || domain.indexOf(d + '.') >= 0; })) score += 2;
      var badDomains = ['youtube.com', 'bilibili.com', 'douyin.com', 'taobao.com',
        'jd.com', 'pinduoduo.com', 'weibo.com', 'zhihu.com/question', 'tieba.baidu.com',
        'xiaohongshu.com', 'kuaishou.com', 'tmall.com'];
      if (badDomains.some(function (d) { return url.indexOf(d) >= 0; })) score -= 4;
      // 教育类查询 + 教育域名额外加分
      var eduQuery = /教案|课件|学案|试卷|教学|课标|高考|备课|命题|解题|知识点|教材|课程|素养|考试|真题|模拟|联考/.test(queryPhrase || '');
      if (eduQuery && score > 0 && (/\.edu|\.ac\.cn|zxxk|5ykj|21cnjy|pep\.com|moe\.gov|gaokao|zujuan|jyeoo|ks5u|gkstk/.test(domain))) score += 2;
      return score;
    },

    /**
     * 构造带上下文的搜索词（注入学科/年级/课题提高精准度）
     */
    _buildContextQuery(query, opts) {
      opts = opts || {};
      var base = this._extractKeywords(query);
      var ctxParts = [];
      if (opts.subject) ctxParts.push(opts.subject);
      if (opts.grade) ctxParts.push(opts.grade);
      // 只在查询本身不含学科/年级信息时注入
      var hasSubject = base.indexOf(opts.subject || '###') >= 0;
      var hasGrade = base.indexOf(opts.grade || '###') >= 0;
      var prefix = '';
      if (opts.subject && !hasSubject) prefix += opts.subject + ' ';
      if (opts.grade && !hasGrade) prefix += opts.grade + ' ';
      return (prefix + base).trim();
    },

    /**
     * 执行搜索
     */
    async search(query, opts) {
      opts = opts || {};
      var num = opts.num || 6;
      if (!query) return { ok: false, error: '查询词为空' };

      // 带上下文的查询构造（注入学科/年级提高精准度）
      var searchQuery;
      if (opts.rawQuery) { searchQuery = query; }
      else if (opts.subject || opts.grade) { searchQuery = this._buildContextQuery(query, opts); }
      else { searchQuery = this._extractKeywords(query); }

      // 缓存命中
      var cached = _cacheGet(searchQuery);
      if (cached) {
        return {
          ok: true,
          data: {
            results: cached,
            query: searchQuery,
            references: cached.map(function (r) { return { title: r.title, url: r.url, source: r.source, snippet: r.snippet }; }),
          },
          engine: 'cache',
          cached: true,
        };
      }

      var results = [];
      var fetchNum = num + 2; // 多取少量，给相关性过滤留余量（原先 num+6 过大，导致总触发全部引擎串行）

      // 1) 配置的搜索 API
      if (opts.apiKey && opts.engine === 'serpapi') {
        results = await this._serpapi(searchQuery, opts.apiKey, fetchNum);
      } else if (opts.apiKey && opts.engine === 'bing') {
        results = await this._bing(searchQuery, opts.apiKey, fetchNum);
      }

      // 2) 无 Key 兜底：直接抓取搜索引擎结果页（Electron 原生 fetch 无 CORS 限制）
      if (!results.length) {
        results = await this._suggestEngines(searchQuery, fetchNum);
      }

      results = _dedupe(results);

      // 3) 相关性打分 + 过滤 + 排序
      var queryLower = searchQuery.toLowerCase();
      var queryTokens = queryLower.split(/\s+/).filter(function (t) { return t.length >= 2; });
      var self = this;
      results.forEach(function (r) { r._score = self._scoreRelevance(r, queryTokens, queryLower); });
      var relevant = results.filter(function (r) { return r._score > 0; });
      // 如果过滤后太少（<2），放宽阈值保留得分最高的
      if (relevant.length < 2 && results.length > 0) {
        relevant = results.slice().sort(function (a, b) { return b._score - a._score; }).slice(0, Math.max(2, num));
      }
      relevant.sort(function (a, b) { return b._score - a._score; });
      results = relevant.slice(0, num);

      if (results.length) _cachePut(searchQuery, results);
      if (results.length === 0) {
        return {
          ok: false,
          error: '未找到相关搜索结果，建议更换关键词或检查网络连接',
          data: { results: [], query: searchQuery, references: [], engine: 'none' },
        };
      }
      var references = results.map(function (r) {
        return { title: r.title, url: r.url, source: r.source, snippet: r.snippet };
      });
      return { ok: true, data: { results: results, query: searchQuery, references: references }, engine: 'auto' };
    },

    // SerpAPI
    async _serpapi(query, key, num) {
      var url = 'https://serpapi.com/search.json?q=' + encodeURIComponent(query) + '&api_key=' + key + '&num=' + num + '&hl=zh-CN';
      var r = await _httpGet(url);
      if (!r.ok) return [];
      try {
        var d = JSON.parse(r.text);
        if (!d || !d.organic_results) return [];
        return d.organic_results.map(function (r) { return { title: r.title, url: r.link, snippet: r.snippet, source: r.source }; });
      } catch (e) { return []; }
    },

    // Bing Web Search API v7（需要 Ocp-Apim-Subscription-Key 认证头）
    async _bing(query, key, num) {
      var url = 'https://api.bing.microsoft.com/v7.0/search?q=' + encodeURIComponent(query) + '&count=' + num + '&mkt=zh-CN';
      var r = await _httpGet(url, 12000, { 'Ocp-Apim-Subscription-Key': key });
      if (!r.ok) return [];
      try {
        var d = JSON.parse(r.text);
        if (!d || !d.webPages || !d.webPages.value) return [];
        return d.webPages.value.map(function (r) { return { title: r.name, url: r.url, snippet: r.snippet, source: r.siteName }; });
      } catch (e) { return []; }
    },

    /**
     * 无 Key 兜底：多搜索引擎并行抓取
     * 改进：原先串行请求 Bing→百度→搜狗→Wikipedia，最坏耗时 38s 远超工具超时；
     *       现改为并行请求 + 时间预算收集，最快引擎返回即可用，整体耗时降至 ~10s。
     */
    async _suggestEngines(query, num) {
      var out = [];
      var self = this;

      // 各引擎独立抓取（互不依赖，可并行）
      function track(p) {
        return p.then(function (results) {
          if (results && results.length) out = out.concat(results);
          return results;
        }).catch(function () { return null; });
      }
      var tasks = [
        track(self._fetchEngineBing(query, num)),
        track(self._fetchEngineBaidu(query, num)),
        track(self._fetchEngineSogou(query, num)),
        track(self._fetchEngineWiki(query, num)),
      ];

      // 第一轮：等待 9 秒预算，收集所有已返回的结果
      await Promise.race([
        Promise.allSettled(tasks),
        new Promise(function (resolve) { setTimeout(resolve, 9000); }),
      ]);

      // 结果不足时再等 4 秒收尾（给慢引擎最后一次机会）
      if (out.length < num) {
        await Promise.race([
          Promise.allSettled(tasks),
          new Promise(function (resolve) { setTimeout(resolve, 4000); }),
        ]);
      }

      // 最终兜底：搜索链接页
      if (out.length === 0) {
        out.push({ title: '在百度搜索：' + query, url: 'https://www.baidu.com/s?wd=' + encodeURIComponent(query), snippet: '点击查看百度搜索结果', source: 'baidu' });
        out.push({ title: '在必应搜索：' + query, url: 'https://www.bing.com/search?q=' + encodeURIComponent(query), snippet: '点击查看必应搜索结果', source: 'bing' });
      }
      return out;
    },

    // 必应搜索（国际版，结果质量好）
    async _fetchEngineBing(query, num) {
      var bingUrl = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&count=' + num + '&setlang=zh-CN';
      var bingR = await _httpGet(bingUrl, 10000, { 'Referer': 'https://www.bing.com/' });
      if (bingR.ok) return _parseSearchResults(bingR.text, 'bing');
      return [];
    },

    // 百度搜索
    async _fetchEngineBaidu(query, num) {
      var baiduUrl = 'https://www.baidu.com/s?wd=' + encodeURIComponent(query) + '&rn=' + (num + 5);
      var baiduR = await _httpGet(baiduUrl, 10000, { 'Referer': 'https://www.baidu.com/' });
      if (baiduR.ok) return _parseSearchResults(baiduR.text, 'baidu');
      return [];
    },

    // 搜狗搜索（补充）
    async _fetchEngineSogou(query, num) {
      var sogouUrl = 'https://www.sogou.com/web?query=' + encodeURIComponent(query) + '&num=' + (num + 5);
      var sogouR = await _httpGet(sogouUrl, 10000, { 'Referer': 'https://www.sogou.com/' });
      if (sogouR.ok) return _parseSearchResults(sogouR.text, 'sogou');
      return [];
    },

    // Wikipedia 中文搜索（API 支持 CORS）
    async _fetchEngineWiki(query, num) {
      var wikiUrl = 'https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent(query) + '&format=json&srprop=snippet&srlimit=' + num + '&origin=*';
      var wikiR = await _httpGet(wikiUrl, 8000);
      if (wikiR.ok) {
        var wd = JSON.parse(wikiR.text);
        if (wd && wd.query && wd.query.search) {
          return wd.query.search.map(function (s) {
            return {
              title: s.title,
              url: 'https://zh.wikipedia.org/wiki/' + encodeURIComponent(s.title),
              snippet: s.snippet.replace(/<[^>]+>/g, ''),
              source: 'Wikipedia',
            };
          });
        }
      }
      return [];
    },

    /**
     * 抓取单个网页正文
     */
    async fetchPage(url, maxChars) {
      maxChars = maxChars || 4000;
      if (!url) return { ok: false, error: 'URL 为空' };

      // 1) 服务器端沙箱可用时优先用
      if (global.AgentSandbox && global.AgentSandbox.serverAvailable) {
        try {
          var sr = await global.AgentSandbox._serverCall('/fetch', { url: url, max_chars: maxChars });
          if (sr.ok && sr.data && sr.data.content) {
            return { ok: true, data: { url: url, content: sr.data.content, source: 'server-fetch' } };
          }
        } catch (e) { /* 降级 */ }
      }

      // 2) Electron 原生 fetch 或 CORS 代理
      var r = await _httpGet(url, 12000);
      if (r.ok && r.text) {
        var text = _htmlToText(r.text, maxChars);
        if (text.length > 100) {
          return { ok: true, data: { url: url, content: text, source: r.source } };
        }
      }

      // 3) 兜底
      return {
        ok: true,
        data: {
          url: url,
          note: '网页正文提取失败，可点击链接人工阅读',
          content: '',
        },
        partial: true,
      };
    },

    /**
     * 搜索 + 抓取 + 整合：一站式信息检索
     */
    async searchAndSummarize(query, opts) {
      opts = opts || {};
      var num = opts.num || 6;
      var fetchCount = opts.fetchCount || 3;
      var maxCharsPerPage = opts.maxCharsPerPage || 3000;

      // 1) 搜索
      var searchResult = await this.search(query, { num: num, apiKey: opts.apiKey, engine: opts.engine, subject: opts.subject, grade: opts.grade });
      if (!searchResult.ok) return searchResult;

      var results = searchResult.data.results;
      var references = searchResult.data.references || [];
      var searchQuery = searchResult.data.query || query;

      // 2) 抓取 Top N 网页内容（自动整合）
      var topResults = results.slice(0, fetchCount).filter(function (r) {
        return r.url && r.url.indexOf('http') === 0 &&
          r.url.indexOf('baidu.com/s?') < 0 &&
          r.url.indexOf('bing.com/search?') < 0 &&
          r.url.indexOf('sogou.com/web?') < 0;
      });

      var pageContents = [];
      // 并行抓取多个网页（原先串行 for 循环，3 页最坏耗时 36s；并行后降至 ~12s）
      var self = this;
      var fetchTasks = topResults.map(function (r) {
        return self.fetchPage(r.url, maxCharsPerPage).then(function (pageResult) {
          return { r: r, pageResult: pageResult };
        }).catch(function () { return null; });
      });
      var settled = await Promise.allSettled(fetchTasks);
      settled.forEach(function (res) {
        if (res.status !== 'fulfilled' || !res.value) return;
        var r = res.value.r;
        var pageResult = res.value.pageResult;
        if (pageResult.ok && pageResult.data && pageResult.data.content && pageResult.data.content.length > 100) {
          pageContents.push({
            title: r.title,
            url: r.url,
            source: r.source || pageResult.data.source,
            content: pageResult.data.content,
          });
        }
      });

      // 3) 整合摘要
      var summary = '';
      if (pageContents.length > 0) {
        summary = '根据搜索到的 ' + pageContents.length + ' 个网页内容，整合如下：\n\n';
        pageContents.forEach(function (p, idx) {
          summary += '【来源' + (idx + 1) + '】' + p.title + '\n';
          summary += 'URL: ' + p.url + '\n';
          summary += p.content.slice(0, maxCharsPerPage) + '\n\n---\n\n';
        });
      } else {
        summary = '以下是搜索到的相关结果摘要：\n\n';
        results.forEach(function (r, idx) {
          summary += '【来源' + (idx + 1) + '】' + r.title + '\n';
          if (r.snippet) summary += r.snippet + '\n';
          if (r.url) summary += 'URL: ' + r.url + '\n';
          summary += '\n';
        });
      }

      return {
        ok: true,
        data: {
          summary: summary,
          references: references,
          results: results,
          query: searchQuery,
          pagesFetched: pageContents.length,
        },
      };
    },

    /** 配置读取 */
    getConfig() {
      try {
        return JSON.parse(localStorage.getItem('teacher_agent_search_config') || '{}');
      } catch (e) { return {}; }
    },
    setConfig(cfg) {
      localStorage.setItem('teacher_agent_search_config', JSON.stringify(cfg));
    },
  };

  // 注册到工具中心
  if (global.AgentTools) {
    global.AgentTools.register('web_search', {
      category: 'web',
      description: '联网搜索：自动提取关键词，通过必应/百度/搜狗搜索引擎检索，抓取Top3网页内容并整合摘要。返回 summary(整合摘要)、references(参考资料列表)、results(搜索结果列表)。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索内容（可以是完整句子，自动提取关键词）' },
          num: { type: 'number', description: '搜索结果数量（默认6）' },
          fetchCount: { type: 'number', description: '自动抓取网页数量（默认3）' },
        },
        required: ['query'],
      },
      handler: async function (a) {
        var cfg = WebSearch.getConfig();
        var actx = global.AgentCurrentCtx || {};
        var r = await WebSearch.searchAndSummarize(a.query, {
          num: a.num || 6,
          fetchCount: a.fetchCount || 3,
          apiKey: cfg.apiKey,
          engine: cfg.engine,
          subject: actx.subject || '',
          grade: actx.grade || '',
        });
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error || '无搜索结果' };
      },
    });

    global.AgentTools.register('web_research', {
      category: 'web',
      description: '深度搜索：搜索+自动抓取Top3网页内容+整合摘要+返回参考资料。适合需要从多个网站获取信息并整合的场景。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索主题（可以是完整句子，自动提取关键词）' },
          num: { type: 'number', description: '搜索结果数量（默认6）' },
          fetchCount: { type: 'number', description: '自动抓取网页数量（默认3）' },
        },
        required: ['query'],
      },
      handler: async function (a) {
        var cfg = WebSearch.getConfig();
        var actx = global.AgentCurrentCtx || {};
        var r = await WebSearch.searchAndSummarize(a.query, {
          num: a.num || 6,
          fetchCount: a.fetchCount || 3,
          apiKey: cfg.apiKey,
          engine: cfg.engine,
          subject: actx.subject || '',
          grade: actx.grade || '',
        });
        return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error || '搜索失败' };
      },
    });

    global.AgentTools.register('fetch_page', {
      category: 'web',
      description: '抓取指定 URL 网页正文（自动去除 HTML 标签，返回纯文本）',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      handler: async function (a) { return await WebSearch.fetchPage(a.url); },
    });
  }

  global.AgentWebSearch = WebSearch;
})(window);
