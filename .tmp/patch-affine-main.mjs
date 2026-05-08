import { readFileSync, writeFileSync } from 'node:fs';

let source = readFileSync('.tmp/affine-current-main.js', 'utf8');

function replaceOnce(search, replacement, label) {
  const index = source.indexOf(search);
  if (index === -1) {
    throw new Error(`Missing patch target: ${label}`);
  }
  source =
    source.slice(0, index) +
    replacement +
    source.slice(index + search.length);
}

replaceOnce(
  ',nj=e=>rM({description:"Crawl',
  ',nExaKey=e=>{let t=e.copilot?.exa?.key;"string"==typeof t&&(t=t.trim());return t&&"your_exa_api_key"!==t.toLowerCase()?t:void 0},nj=e=>rM({description:"Crawl',
  'insert Exa key helper'
);

replaceOnce(
  'try{let{key:r}=e.copilot.exa,o=new eR.default(r);return(await o.getContents',
  'try{let r=nExaKey(e);if(!r)return ni("Exa Crawl Failed","Exa API key is not configured.");let o=new eR.default(r);return(await o.getContents',
  'guard Exa crawl key'
);

replaceOnce(
  'try{let{key:o}=e.copilot.exa,i=new eR.default(o);return(await i.search',
  'try{let o=nExaKey(e);if(!o)return ni("Exa Search Failed","Exa API key is not configured.");let i=new eR.default(o);return(await i.search',
  'guard Exa search key'
);

replaceOnce(
  'content:e.summary,favicon:e.favicon',
  'content:e.summary??"",favicon:e.favicon',
  'default Exa summary content'
);

replaceOnce(
  'case"docSemanticSearch":o.doc_semantic_search=nS(nw(this.ac,this.context,e.session,this.models).bind(null,e));break;case"docKeywordSearch":this.config.indexer.enabled&&(o.doc_keyword_search=nh(nm(this.ac,this.indexerService,this.models).bind(null,e)));break;case"docRead":o.doc_read=nv(nb(this.ac,this.docReader,this.models).bind(null,e));break;',
  'case"docSemanticSearch":(!e.workspace||await this.models.workspace.get(e.workspace))&&(o.doc_semantic_search=nS(nw(this.ac,this.context,e.session,this.models).bind(null,e)));break;case"docKeywordSearch":this.config.indexer.enabled&&(!e.workspace||await this.models.workspace.get(e.workspace))&&(o.doc_keyword_search=nh(nm(this.ac,this.indexerService,this.models).bind(null,e)));break;case"docRead":(!e.workspace||await this.models.workspace.get(e.workspace))&&(o.doc_read=nv(nb(this.ac,this.docReader,this.models).bind(null,e)));break;',
  'skip workspace tools for local-only workspaces'
);

replaceOnce(
  'case"webSearch":o.web_search_exa=nP(this.config),o.web_crawl_exa=nj(this.config);break;',
  'case"webSearch":nExaKey(this.config)&&(o.web_search_exa=nP(this.config),o.web_crawl_exa=nj(this.config));break;',
  'register Exa tools only when configured'
);

writeFileSync('.tmp/affine-patched-main.js', source);
