#!/bin/bash
# ============================================================
# 教师备课智能体 · LaTeX 额外宏包安装脚本
# ------------------------------------------------------------
# 在 texlive apt 基础包之上,使用 tlmgr 安装备课所需的
# 中文 / 科学 / 排版 / 表格 / 图形宏包
#
# 用法: Dockerfile 构建期执行
#   RUN /tmp/install-latex-packages.sh
#
# 策略: 单个宏包失败不阻塞构建(已安装 / 仓库缺失均视为正常)
# ============================================================
set -u  # 不使用 -e,允许单个宏包失败时继续

echo "[latex] ============================================"
echo "[latex] LaTeX 额外宏包安装脚本启动"
echo "[latex] ============================================"

# ---- 检查 tlmgr 是否可用 ----
if ! command -v tlmgr >/dev/null 2>&1; then
    echo "[latex] 警告: tlmgr 未找到,跳过宏包安装"
    echo "[latex] 请确认 texlive-base 已通过 apt 安装"
    exit 0
fi

echo "[latex] tlmgr 路径: $(command -v tlmgr)"
echo "[latex] tlmgr 版本: $(tlmgr --version 2>&1 | head -1)"

# ---- 初始化 tlmgr 用户树(如果尚未初始化) ----
# Debian 的 texlive 默认是只读 root 模式,tlmgr 可能需要 user 模式
if tlmgr --usermode info ctex >/dev/null 2>&1; then
    echo "[latex] tlmgr user 模式已就绪"
else
    echo "[latex] 初始化 tlmgr user 模式..."
    tlmgr init-usertree 2>/dev/null || true
fi

# ---- 设置 CTAN 仓库(加速下载,失败不阻塞) ----
echo "[latex] 设置 TeX Live 仓库..."
tlmgr option repository https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet 2>/dev/null \
    || tlmgr option repository ctan 2>/dev/null \
    || echo "[latex] 警告: 仓库设置失败,使用默认仓库"

# ---- 更新 tlmgr 自身(可选,失败不阻塞) ----
echo "[latex] 更新 tlmgr 自身..."
tlmgr update --self 2>/dev/null || echo "[latex] tlmgr 自更新跳过(可能无网络或只读)"

# ============================================================
# 待安装宏包清单
# ------------------------------------------------------------
# 注: 许多宏包已包含在 apt 安装的 texlive-* 包中:
#   texlive-xetex          -> fontspec, polyglossia
#   texlive-lang-chinese    -> ctex, xeCJK
#   texlive-latex-extra     -> geometry, fancyhdr, titlesec, enumitem,
#                              booktabs, longtable, tabularx, tcolorbox,
#                              listings, hyperref, mathtools, caption
#   texlive-science         -> siunitx, algorithms
#   texlive-pictures        -> tikz, pgfplots
#   texlive-bibtex-extra    -> biblatex
# tlmgr 安装主要用于补全缺失宏包或获取更新版本
# ============================================================
PACKAGES=(
    # ---- 中文支持 ----
    ctex
    xeCJK
    # ---- 字体与排版 ----
    fontspec
    geometry
    fancyhdr
    titlesec
    # ---- 列表与枚举 ----
    enumitem
    # ---- 表格 ----
    booktabs
    longtable
    multirow
    array
    tabularx
    # ---- 图形与颜色 ----
    graphicx
    xcolor
    tcolorbox
    # ---- 代码排版 ----
    listings
    minted
    # ---- 超链接 ----
    hyperref
    # ---- 数学 ----
    amsmath
    amssymb
    amsthm
    mathtools
    physics
    # ---- 化学 ----
    chemfig
    mhchem
    # ---- 图形绘制 ----
    tikz
    pgfplots
    standalone
    # ---- 图表与浮动体 ----
    subcaption
    float
    wrapfig
    caption
    # ---- 参考文献 ----
    biblatex
    biber
)

echo "[latex] --------------------------------------------"
echo "[latex] 待安装宏包数: ${#PACKAGES[@]}"
echo "[latex] 宏包列表: ${PACKAGES[*]}"
echo "[latex] --------------------------------------------"

SUCCESS=0
ALREADY=0
FAILED=0
FAILED_LIST=()

for pkg in "${PACKAGES[@]}"; do
    echo "---- 安装: ${pkg} ----"
    LOGFILE="/tmp/tlmgr-${pkg}.log"
    # 尝试 user 模式安装,失败则尝试普通模式
    if tlmgr --usermode install "${pkg}" >"${LOGFILE}" 2>&1 \
        || tlmgr install "${pkg}" >"${LOGFILE}" 2>&1; then
        # 检查是否实际安装了(避免 "already installed" 误判)
        if grep -qi "already installed\|已安装" "${LOGFILE}" 2>/dev/null; then
            echo "  [ALREADY] ${pkg} (已安装)"
            ALREADY=$((ALREADY + 1))
        else
            echo "  [OK] ${pkg}"
            SUCCESS=$((SUCCESS + 1))
        fi
    else
        # 检查是否因为已安装而"失败"
        if grep -qi "already installed\|已安装" "${LOGFILE}" 2>/dev/null; then
            echo "  [ALREADY] ${pkg} (已安装)"
            ALREADY=$((ALREADY + 1))
        else
            echo "  [SKIP] ${pkg} (安装失败,可能已包含在 apt 包中或仓库缺失)"
            FAILED=$((FAILED + 1))
            FAILED_LIST+=("${pkg}")
        fi
    fi
done

echo ""
echo "[latex] ============================================"
echo "[latex] LaTeX 宏包安装完成"
echo "[latex]   新安装: ${SUCCESS}"
echo "[latex]   已存在: ${ALREADY}"
echo "[latex]   跳过/失败: ${FAILED}"
if [ "${FAILED}" -gt 0 ]; then
    echo "[latex]   跳过列表: ${FAILED_LIST[*]}"
    echo "[latex]   (这些宏包多数已包含在 apt 安装的 texlive-* 包中,属正常现象)"
fi
echo "[latex] ============================================"

# 清理临时日志
rm -f /tmp/tlmgr-*.log 2>/dev/null || true

exit 0
