import { defineConfig } from 'vite';
import path from 'node:path';
import { chmod, readFile, writeFile } from 'node:fs/promises';

// Keep the shipped assets immutable. These version-checked adapters are applied
// only to derived build output, inside the original React/provider tree.
const localDesktopSurfaces = {
  name: 'local-desktop-surfaces',
  async closeBundle() {
    const assets = path.resolve(__dirname, 'dist/original/assets');
    const adapt = async (file: string, transform: (source: string) => string) => {
      const target = path.join(assets, file);
      const source = await readFile(target, 'utf8');
      const result = transform(source);
      if (result === source) throw new Error(`Recovered surface adapter did not match ${file}`);
      // Vite's public copy preserves the original assets' Windows read-only bit.
      // Only the derived output is made writable; source attributes stay intact.
      await chmod(target, 0o666);
      await writeFile(target, result);
    };
    await adapt('plugins-skills-tabs-d4bcf38f1eae.js', source => {
      const anchor = 'children:i.slice(0,6).map((e,r)=>';
      if (source.split(anchor).length !== 2) throw new Error('Public plugin grid contract changed');
      const installed = 'ae={error:null,isLoading:!1,sections:d}';
      const personalLimit = 'e.plugins.slice(0,6)';
      const personalMore = 'e.plugins.length>6||e.kind===`shared`&&e.hasNextPage?';
      for (const contract of [installed, personalLimit, personalMore]) {
        if (source.split(contract).length !== 2) throw new Error('Personal installed plugin contract changed');
      }
      return source.replace(anchor, 'children:i.map((e,r)=>')
        .replace(installed, 'ae={error:null,isLoading:!1,sections:[{id:`plugins-installed`,kind:`installed`,title:`已安裝`,plugins:yr({hiddenPluginIds:e,installedPlugins:E,localPlugins:E.filter(e=>e.plugin.installed),remotePlugins:[]})}]}')
        .replace(personalLimit, '(e.kind===`installed`?e.plugins:e.plugins.slice(0,6))')
        .replace(personalMore, 'e.kind!==`installed`&&(e.plugins.length>6||e.kind===`shared`&&e.hasNextPage)?');
    });
    // Native route constants and their four exact root-path comparisons move
    // together. Settings routes and the code-review area identifier stay intact.
    await adapt('app-shared-624e1c099f95.js', source => {
      const anchor = 'Y5e=`/code-review`';
      if (source.split(anchor).length !== 2) throw new Error('Pull request route constant changed');
      const protocols = 'Dln=/^(https?|ircs?|xmpp|codex)$/i';
      if (source.split(protocols).length !== 2) throw new Error('Markdown URL scheme contract changed');
      const sanitizeLink = 'function q4(e){let t=e.indexOf(`:`)';
      if (source.split(sanitizeLink).length !== 2) throw new Error('Local skill link sanitizer contract changed');
      return source.replace(anchor, 'Y5e=`/pull-requests`')
        // Drive-letter paths are local references, not arbitrary URL schemes.
        .replace(sanitizeLink, String.raw`function q4(e){if(/^[a-z]:[\\/]/i.test(e))return e;let t=e.indexOf(\`:\`)`.replaceAll('\\`', '`'))
        .replace(protocols, 'Dln=/^(https?|ircs?|xmpp|codex|codex-asset)$/i');
    });
    await adapt('app-primary-8eba40dc50b2.js', source => {
      const anchor = '`/code-review`';
      if (source.split(anchor).length !== 5) throw new Error('Pull request route comparisons changed');
      const catalogLimit = 'plugins:e.plugins.slice(0,9)';
      if (source.split(catalogLimit).length !== 2) throw new Error('Public plugin category contract changed');
      const skillCommand = 'requiresEmptyComposer:!1,Icon:{assets:{16:tre,20:tae}},RightIcon:';
      if (source.split(skillCommand).length !== 2) throw new Error('Slash skill icon contract changed');
      return source.replaceAll(anchor, '`/pull-requests`').replace(catalogLimit, 'plugins:e.plugins')
        .replace(skillCommand, 'requiresEmptyComposer:!1,leftAccessory:t.interface?.iconSmall?(0,aQr.jsx)(`img`,{src:t.interface.iconSmall,alt:``,className:`icon-sm shrink-0`}):void 0,Icon:{assets:{16:tre,20:tae}},RightIcon:');
    });
    await adapt('app-initial-b0cd131b9dba.js', source => {
      const anchor = 'let Ee=vNn({plugins:';
      if (source.split(anchor).length !== 2) throw new Error('Installed plugin mention contract changed');
      const start = source.indexOf(anchor) + 'let Ee='.length;
      let depth = 0;
      let end = -1;
      for (let index = start + 'vNn'.length; index < source.length; index++) {
        if (source[index] === '(') depth++;
        else if (source[index] === ')' && --depth === 0) { end = index + 1; break; }
      }
      if (end < 0 || end - start > 1200) throw new Error('Installed plugin mention call changed');
      // Selection lists installed packages. Device execution retains its own
      // readiness checks; the menu does not claim a browser or desktop session.
      const recovered = source.slice(0, start)
        + '[...(fe??[]).filter(Te),...we].filter(e=>e.plugin.installed&&e.plugin.enabled)'
        + source.slice(end);
      // Route local image schemes and relative image paths through the shipped
      // workspaceFiles.readBinary query, keeping the original image component,
      // lightbox, MIME handling and layout intact. Only derived assets change.
      const mediaPath = 'ne=L!=null&&Va(R)?vo(R):Mn(R)';
      if (recovered.split(mediaPath).length !== 2) throw new Error('Local markdown image path contract changed');
      const parseMarkdown = 'let e=ZPs(r,re,ne)';
      if (recovered.split(parseMarkdown).length !== 2) throw new Error('Markdown parsing contract changed');
      const parseUserMarkdown = 'cj(ZPs(n,ee,R),o,';
      if (recovered.split(parseUserMarkdown).length !== 2) throw new Error('User message Markdown parsing contract changed');
      // Protect image and explicit $skill destinations from Markdown backslash
      // escapes. Code examples and persisted message text remain unchanged.
      const normalizeImages = String.raw`function localImageMarkdown(text){return typeof text!=="string"?text:text.replace(/(\x60{3,}[^\n]*\n[\s\S]*?\n\x60{3,}|~{3,}[^\n]*\n[\s\S]*?\n~{3,}|\x60+[^\x60\n]*\x60+)|((?:!\[|\[\$)[^\]\r\n]*\]\(\s*<?)([a-z]:\\[^>\r\n]*?)(>?)(?=\))/gi,(match,code,prefix,local,suffix)=>{if(code)return match;let path=local.replaceAll("\\","/");return prefix.startsWith("[$")?prefix.replace(/<$/,"")+encodeURI(path).replace(/\(/g,"%28").replace(/\)/g,"%29"):prefix+path+suffix})}`;
      const menuIcon = 'icon:F$(r),type:`mention`';
      const composerIcon = 'let h=e===`skill-mention`||t&&l.attrs.skillIcon!=null?';
      const messageIcon = 'y=F$(s??(r?Sme(o,n).skillIcon??void 0:void 0))';
      for (const contract of [menuIcon, composerIcon, messageIcon]) {
        if (recovered.split(contract).length !== 2) throw new Error('Local skill artwork rendering contract changed');
      }
      return normalizeImages + '\n' + recovered
        .replace(menuIcon, 'icon:zga(e,{renderCustomSvgAsImage:!0,fallbackIcon:F$(r)}),type:`mention`')
        .replace(composerIcon, 'let h=e===`skill-mention`&&m?Bga(null,{iconSmall:m,basePath:l.attrs.path,alt:f,fallbackIcon:c,renderCustomSvgAsImage:!0}):e===`skill-mention`||t&&l.attrs.skillIcon!=null?')
        .replace(messageIcon, 'y=c?.interface?.iconSmall?zga(c,{renderCustomSvgAsImage:!0}):F$(s??(r?Sme(o,n).skillIcon??void 0:void 0))')
        .replace(mediaPath,
        'ne=L!=null&&Va(R)?vo(R):(/^(?:file:|codex-asset:|app:\\/\\/fs\\/@fs\\/)/i.test(R)||(!/^[a-z][a-z0-9+.-]*:/i.test(R)&&!R.startsWith(`//`)&&/\\.(?:png|jpe?g|webp|gif|avif|bmp|ico)$/i.test(R))?R:Mn(R))')
        .replace(parseUserMarkdown, 'cj(ZPs(localImageMarkdown(n),ee,R),o,')
        .replace(parseMarkdown, 'let e=ZPs(localImageMarkdown(r),re,ne)');
    });
    await adapt('sidebar-b1772352d7e5.js', source => {
      const anchor = '(0,$.jsx)(Qn,{})';
      if (source.split(anchor).length !== 2) throw new Error('Hosted PR watcher contract changed');
      // Qn writes the private cloud query into G6. The local page instead reads
      // its real gh-backed snapshot, without mounting that hosted writer.
      return source.replace(anchor, 'null');
    });
    await adapt('page-c32716057aee.js', source => {
      const anchor = 'export{Or as CodeReviewPage};';
      if (source.split(anchor).length !== 2) throw new Error('Pull request page contract changed');
      return 'import{CodeReviewSidebar as LocalCodeReviewSidebar}from"./sidebar-b1772352d7e5.js";\n'
        + source.replace(anchor, `
function LocalCodeReviewPage(){return(0,$.jsxs)("div",{
  className:"flex min-h-0 flex-1 overflow-hidden",
  "data-local-pr-route":"/pull-requests",
  children:[(0,$.jsx)("aside",{
    className:"flex min-h-0 shrink-0 flex-col border-r border-subtle",
    style:{width:"320px"},"aria-label":"Pull Request 清單",
    children:(0,$.jsx)(LocalCodeReviewSidebar,{})
  }),(0,$.jsx)("div",{
    className:"flex min-w-0 flex-1 flex-col",
    "data-local-pr-detail":true,children:(0,$.jsx)(Or,{})
  })]
})}export{LocalCodeReviewPage as CodeReviewPage};`);
    });
  },
};
export default defineConfig({
  root: 'frontend',
  base: './',
  publicDir: 'public',
  plugins: [localDesktopSurfaces],
  build: { outDir: '../dist', emptyOutDir: true },
  resolve: { alias: { '@': path.resolve(__dirname, 'frontend/src') } }
});
