
 /* ---- 桌面应用本地资源路径（Electron 下指向 www 目录，浏览器回退 CDN） ---- */
 function vendorUrl(localRel: LegacyBoundary, cdnUrl: LegacyBoundary){
  try{
   if(window.electronAPI && window.electronAPI.resourceRoot){
    var base=String(window.electronAPI.resourceRoot).replace(/\\/g,'/');
    if(base.charAt(base.length-1)!=='/') base+='/';
    return 'file://'+base+localRel;
   }
  }catch(e){}
  return cdnUrl;
 }
 var KATEX_CSS=vendorUrl('teacher-agent-sandbox/vendor/katex/katex.min.css','https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css');
 var KATEX_JS=vendorUrl('teacher-agent-sandbox/vendor/katex/katex.min.js','https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js');
 var KATEX_AUTO=vendorUrl('teacher-agent-sandbox/vendor/katex/auto-render.min.js','https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js');
 var FA_CSS=vendorUrl('teacher-agent-sandbox/vendor/font-awesome/css/all.min.css','https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css');

 tailwind.config = {
 theme: {
 extend: {
 colors: {
 /* 暖墨色阶：宣纸米白 → 暖褐灰 → 暖墨黑 */
 ink: {
 50:'#faf8f3',100:'#f3eee4',200:'#e8dfd0',300:'#d9ccb8',
 400:'#a89a82',500:'#7a6f5c',600:'#5b5345',700:'#403a30',
 800:'#2b271f',900:'#19160f'
 },
 /* 竹青（松柏绿）主色：温润不沉 */
 jade: {
 50:'#eef4f0',100:'#dae8e0',200:'#b6cdbe',300:'#90b29d',
 400:'#6e9882',500:'#4f7a66',600:'#3f6453',700:'#345042',800:'#263a30'
 },
 /* 秋香赭：点缀印章/分隔装饰 */
 tan: { 300:'#d4b48f',400:'#bd9a6c',500:'#a8814e',600:'#8c6a3e' }
 },
 fontFamily: {
 serif: ['"Noto Serif SC"','STSong','SimSun','serif'],
 sans: ['"Noto Sans SC"','system-ui','sans-serif'],
 display: ['"Noto Serif SC"','STKaiti','KaiTi','serif'],
 }
 }
 }
 }
 