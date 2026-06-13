const K={
  products:"npc_v13_8_products", orders:"npc_v13_8_orders", customers:"npc_v13_8_customers",
  suppliers:"npc_v13_8_suppliers", messages:"npc_v13_8_messages", settings:"npc_v13_8_settings", seeded:"npc_v13_8_seeded"
};
const STORE="Neo Prime Box";
const APP_VERSION="13.8.3";
const $=id=>document.getElementById(id);
let NPC_APP_STARTED=false;
let NPC_SYNC_PAUSED=false;
// V13.8.3: o Supabase passa a ser a fonte principal dos dados.
// Não usamos mais localStorage/cookie como fonte para produtos, pedidos, clientes, fornecedores e mensagens.
const NPC_MEMORY={products:[], orders:[], customers:[], suppliers:[], messages:[]};
const read=k=>{
  const name=storageKeyToDataName(k);
  if(name && Object.prototype.hasOwnProperty.call(NPC_MEMORY,name)) return NPC_MEMORY[name] || [];
  return JSON.parse(localStorage.getItem(k)||"[]");
};
const write=(k,v)=>{
  const name=storageKeyToDataName(k);
  if(name && Object.prototype.hasOwnProperty.call(NPC_MEMORY,name)){
    NPC_MEMORY[name]=Array.isArray(v)?v:[];
  }else{
    localStorage.setItem(k,JSON.stringify(v));
  }
  if(NPC_APP_STARTED && !NPC_SYNC_PAUSED && name) scheduleSupabaseSync(name);
};
const LEGACY_VERSIONS=["13_7","13_6","13_5","13_4","13_3","13_2","13_1"];
const DATA_KEYS=["products","orders","customers","suppliers","messages","settings"];
function legacyKey(version,name){return `npc_v${version}_${name}`;}
function currentKey(name){return K[name];}
function readAnyStorageJson(key, fallback=null){try{return JSON.parse(localStorage.getItem(key)||JSON.stringify(fallback));}catch(e){return fallback;}}
function storageArrayLength(key){const v=readAnyStorageJson(key,[]);return Array.isArray(v)?v.length:0;}
function migrateFromPreviousVersions(){
  if(localStorage.getItem(K.seeded)) return false;
  let migrated=false;
  for(const name of ["products","orders","customers","suppliers","messages"]){
    if(storageArrayLength(currentKey(name))>0) continue;
    let bestKey="", bestCount=0;
    for(const ver of LEGACY_VERSIONS){
      const lk=legacyKey(ver,name); const count=storageArrayLength(lk);
      if(count>bestCount){bestKey=lk;bestCount=count;}
    }
    if(bestKey && bestCount>0){
      localStorage.setItem(currentKey(name), localStorage.getItem(bestKey));
      migrated=true;
    }
  }
  if(!localStorage.getItem(K.settings)){
    for(const ver of LEGACY_VERSIONS){const lk=legacyKey(ver,"settings"); if(localStorage.getItem(lk)){localStorage.setItem(K.settings,localStorage.getItem(lk));migrated=true;break;}}
  }
  if(migrated) localStorage.setItem(K.seeded,"1");
  return migrated;
}
const uuid=()=>crypto.randomUUID?crypto.randomUUID():String(Date.now()+Math.random());
const num=v=>Number(String(v||"0").replace(",", "."))||0;
const brl=v=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(num(v));
const esc=v=>String(v??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));
const today=()=>new Date().toISOString().slice(0,10);
const lineQuantity=o=>Math.max(1, num(o.quantity)||1);
// V13.2: receita real considera a coluna Total do CSV quando existe.
// Se não existir, calcula preço unitário x quantidade + frete.
const revenue=o=>{
  const storedTotal=num(o.totalRevenue);
  if(storedTotal) return storedTotal;
  return (num(o.salePrice)*lineQuantity(o))+num(o.saleShipping);
};
const productRevenue=p=>num(p?.salePrice)+num(p?.saleShipping);
const productCost=p=>num(p?.buyPrice)+num(p?.buyShipping);
const productExpectedProfit=p=>productRevenue(p)-productCost(p)-num(p?.amazonFees);
const supplierOrderCost=o=>{
  const storedSupplier=num(o.totalSupplier);
  if(storedSupplier) return storedSupplier;
  return (num(o.buyPrice)*(num(o.supplierQuantity)||lineQuantity(o)))+num(o.buyShipping)-num(o.buyDiscount);
};
const cost=o=>supplierOrderCost(o)+num(o.amazonFees);
// V13.2: quando o CSV trouxer Lucro, o dashboard usa esse valor para bater com a planilha.
const hasCsvProfit=o=>o && (o.hasNetProfit===true || (o.netProfit!==undefined && o.netProfit!==null && String(o.netProfit).trim()!=="" && o.netProfitSource!=="calculated"));
const profit=o=>{
  // Se o CSV trouxe a coluna Lucro, usa ela mesmo quando o valor é 0.
  // Isso evita recalcular lucro para pedidos reembolsados/cancelados com Lucro = 0.
  if(hasCsvProfit(o)) return num(o.netProfit);
  return revenue(o)-cost(o);
};
const margin=(profitValue,revenueValue)=>num(revenueValue)?(num(profitValue)/num(revenueValue)*100):0;
const amazonFeeDisplay=o=>num(o?.amazonFees)>0?brl(o.amazonFees):`<span class="pendingText">Pendente</span>`;
const marginClass=v=>v>=25?"marginHigh":v>=15?"marginMid":"marginLow";


// V13.8 - camada Supabase relacional em português.
// A aplicação consulta o Supabase como fonte principal.
// localStorage fica restrito a configurações/compatibilidade e não alimenta listas operacionais.
const NPC_TABLES={
  suppliers:"fornecedores",
  products:"produtos",
  customers:"clientes",
  messages:"mensagens",
  orders:"pedidos"
};
const NPC_CONFIG=window.NPC_SUPABASE_CONFIG||{};
let npcSupabase=null;
const npcSyncTimers={};
function storageKeyToDataName(k){return Object.entries(K).find(([name,key])=>key===k)?.[0]||"";}
function supabaseConfigured(){return !!(NPC_CONFIG.url && NPC_CONFIG.key && !String(NPC_CONFIG.key).includes("COLE_AQUI") && !String(NPC_CONFIG.url).includes("COLE_AQUI"));}
function getSupabase(){
  if(!supabaseConfigured()) return null;
  if(npcSupabase) return npcSupabase;
  if(!window.supabase || !window.supabase.createClient){console.warn("Supabase SDK não carregado."); return null;}
  npcSupabase=window.supabase.createClient(NPC_CONFIG.url, NPC_CONFIG.key);
  return npcSupabase;
}
function setSyncStatus(msg,type="info"){
  let el=document.getElementById("npcSyncStatus");
  if(!el){
    el=document.createElement("div"); el.id="npcSyncStatus";
    el.style.cssText="position:fixed;right:14px;bottom:14px;z-index:9999;padding:8px 12px;border-radius:999px;font:12px system-ui;background:#111827;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.18);opacity:.92";
    document.body.appendChild(el);
  }
  el.textContent=msg;
  el.style.background=type==="error"?"#991b1b":type==="success"?"#065f46":"#111827";
  clearTimeout(el._timer); el._timer=setTimeout(()=>{el.remove();},4500);
}
function compactText(v){return String(v??"").trim();}
function dbDate(v){return v?String(v).slice(0,10):null;}
function jsToDb(name,x){
  if(!x) return null;
  if(name==="suppliers") return {
    id:x.id, nome:compactText(x.name)||"Fornecedor sem nome", tipo:x.type||null, contato:x.contact||x.contato||null,
    telefone:x.phone||x.telefone||x.whatsapp||null, email:x.email||null, site:x.site||null,
    prazo_medio_envio:x.leadTime||x.prazo_medio_envio||null, status:x.status||"Ativo", observacoes:x.notes||x.observacoes||null,
    data_criacao:x.createdAt||x.data_criacao||new Date().toISOString(), data_atualizacao:x.updatedAt||new Date().toISOString()
  };
  if(name==="products") return {
    id:x.id, nome:compactText(x.name)||"Produto sem nome", categoria:x.category||null, asin:x.asin||null, sku:x.sku||null,
    ean:x.ean||null, gtin:x.gtin||null, fornecedor_id:x.supplierId||null, link_compra:x.buyLink||null, imagem_url:x.imageUrl||x.imagem_url||null,
    status:x.status||"Ativo na Amazon", preco_compra:num(x.buyPrice), frete_compra:num(x.buyShipping), preco_venda:num(x.salePrice),
    frete_venda:num(x.saleShipping), taxas_amazon:num(x.amazonFees), observacoes:x.notes||null,
    data_criacao:x.createdAt||new Date().toISOString(), data_atualizacao:x.updatedAt||new Date().toISOString()
  };
  if(name==="customers") return {
    id:x.id, nome:compactText(x.name)||"Cliente sem nome", telefone:x.phone||null, email:x.email||null,
    observacoes:customerNotesToDb(x), data_criacao:x.createdAt||new Date().toISOString(), data_atualizacao:x.updatedAt||new Date().toISOString()
  };
  if(name==="messages") return {
    id:x.id, nome:compactText(x.name)||"Mensagem sem nome", tipo:x.type||"Geral", texto:x.body||"", ativo:x.active!==false,
    data_criacao:x.createdAt||new Date().toISOString(), data_atualizacao:x.updatedAt||new Date().toISOString()
  };
  if(name==="orders") return {
    id:x.id, data_pedido:dbDate(x.orderDate), numero_pedido_amazon:x.amazonOrderId||null,
    produto_id:x.productId||null, nome_produto:x.productName||null, cliente_id:x.customerId||null, nome_cliente:x.customerName||null,
    telefone_cliente:x.customerPhone||null, cep_cliente:x.customerCep||null, endereco_cliente:x.customerAddress||null, numero_cliente:x.customerNumber||null,
    complemento_cliente:x.customerComplement||null, bairro_cliente:x.customerDistrict||null, cidade_cliente:x.customerCity||null, uf_cliente:x.customerUf||null,
    fornecedor_id:x.supplierId||null, link_compra:x.buyLink||null, status:x.status||"Venda realizada Amazon",
    preco_venda:num(x.salePrice), frete_venda:num(x.saleShipping), quantidade:num(x.quantity)||1, receita_total:num(x.totalRevenue)||revenue(x),
    preco_compra:num(x.buyPrice), frete_compra:num(x.buyShipping), desconto_compra:num(x.buyDiscount), custo_total_fornecedor:num(x.totalSupplier)||supplierOrderCost(x),
    quantidade_fornecedor:num(x.supplierQuantity)||num(x.quantity)||1, taxas_amazon:num(x.amazonFees), lucro_liquido:hasCsvProfit(x)?num(x.netProfit):profit(x),
    tem_lucro_liquido:!!hasCsvProfit(x), origem_lucro_liquido:x.netProfitSource||null, codigo_rastreio:x.trackingCode||null,
    rastreio_enviado:x.trackingSent||"Não", mensagem_id:x.messageTemplateId||null, observacoes:x.notes||null,
    data_criacao:x.createdAt||new Date().toISOString(), data_atualizacao:x.updatedAt||new Date().toISOString()
  };
  return null;
}
function customerNotesToDb(x){
  const extras={cep:x.cep||"", address:x.address||"", number:x.number||"", complement:x.complement||"", district:x.district||"", city:x.city||"", uf:x.uf||"", notes:x.notes||""};
  const hasExtras=Object.values(extras).some(Boolean);
  return hasExtras?`NPC_EXTRA:${JSON.stringify(extras)}`:(x.notes||null);
}
function customerNotesFromDb(v){
  const s=String(v||"");
  if(!s.startsWith("NPC_EXTRA:")) return {notes:s};
  try{return JSON.parse(s.slice("NPC_EXTRA:".length));}catch(e){return {notes:s};}
}
function dbToJs(name,x){
  if(!x) return null;
  if(name==="suppliers") return {id:x.id,name:x.nome,type:x.tipo||"",contact:x.contato||"",phone:x.telefone||"",whatsapp:x.telefone||"",email:x.email||"",site:x.site||"",leadTime:x.prazo_medio_envio||"",status:x.status||"Ativo",notes:x.observacoes||"",createdAt:x.data_criacao,updatedAt:x.data_atualizacao};
  if(name==="products") return {id:x.id,name:x.nome,category:x.categoria||"",asin:x.asin||"",sku:x.sku||"",ean:x.ean||"",gtin:x.gtin||"",supplierId:x.fornecedor_id||"",buyLink:x.link_compra||"",imageUrl:x.imagem_url||"",status:x.status||"Ativo na Amazon",buyPrice:num(x.preco_compra),buyShipping:num(x.frete_compra),salePrice:num(x.preco_venda),saleShipping:num(x.frete_venda),amazonFees:num(x.taxas_amazon),notes:x.observacoes||"",createdAt:x.data_criacao,updatedAt:x.data_atualizacao};
  if(name==="customers"){const extra=customerNotesFromDb(x.observacoes);return {id:x.id,name:x.nome,phone:x.telefone||"",email:x.email||"",cep:extra.cep||"",address:extra.address||"",number:extra.number||"",complement:extra.complement||"",district:extra.district||"",city:extra.city||"",uf:extra.uf||"",notes:extra.notes||"",createdAt:x.data_criacao,updatedAt:x.data_atualizacao};}
  if(name==="messages") return {id:x.id,name:x.nome,type:x.tipo||"",body:x.texto||"",active:x.ativo!==false,createdAt:x.data_criacao,updatedAt:x.data_atualizacao};
  if(name==="orders") return {id:x.id,orderDate:x.data_pedido||"",amazonOrderId:x.numero_pedido_amazon||"",productId:x.produto_id||"",productName:x.nome_produto||"",customerId:x.cliente_id||"",customerName:x.nome_cliente||"",customerPhone:x.telefone_cliente||"",customerCep:x.cep_cliente||"",customerAddress:x.endereco_cliente||"",customerNumber:x.numero_cliente||"",customerComplement:x.complemento_cliente||"",customerDistrict:x.bairro_cliente||"",customerCity:x.cidade_cliente||"",customerUf:x.uf_cliente||"",supplierId:x.fornecedor_id||"",buyLink:x.link_compra||"",status:x.status||"Venda realizada Amazon",salePrice:num(x.preco_venda),saleShipping:num(x.frete_venda),quantity:num(x.quantidade)||1,totalRevenue:num(x.receita_total),buyPrice:num(x.preco_compra),buyShipping:num(x.frete_compra),buyDiscount:num(x.desconto_compra),totalSupplier:num(x.custo_total_fornecedor),supplierQuantity:num(x.quantidade_fornecedor)||1,amazonFees:num(x.taxas_amazon),netProfit:num(x.lucro_liquido),hasNetProfit:!!x.tem_lucro_liquido,netProfitSource:x.origem_lucro_liquido||"",trackingCode:x.codigo_rastreio||"",trackingSent:x.rastreio_enviado||"Não",messageTemplateId:x.mensagem_id||"",notes:x.observacoes||"",createdAt:x.data_criacao,updatedAt:x.data_atualizacao};
  return null;
}
function scheduleSupabaseSync(name){
  if(!NPC_TABLES[name]) return;
  clearTimeout(npcSyncTimers[name]);
  npcSyncTimers[name]=setTimeout(()=>syncDataNameToSupabase(name),700);
}
async function syncDataNameToSupabase(name){
  const sb=getSupabase(); if(!sb || !NPC_TABLES[name]) return;
  const table=NPC_TABLES[name];
  try{
    const arr=read(K[name]||"").filter(Boolean);
    const rows=arr.map(x=>jsToDb(name,x)).filter(x=>x && x.id);
    if(rows.length){
      const {error}=await sb.from(table).upsert(rows,{onConflict:"id"});
      if(error) throw error;
    }
    const localIds=new Set(rows.map(r=>r.id));
    const {data:remoteIds,error:selErr}=await sb.from(table).select("id");
    if(selErr) throw selErr;
    const toDelete=(remoteIds||[]).map(r=>r.id).filter(id=>!localIds.has(id));
    for(const id of toDelete){const {error}=await sb.from(table).delete().eq("id",id); if(error) throw error;}
    setSyncStatus(`Sincronizado: ${table}`,"success");
  }catch(e){console.error("Erro Supabase",table,e); setSyncStatus(`Erro ao sincronizar ${table}: ${e.message||e}`,"error");}
}
async function loadSupabaseToLocalOrUploadLocal(){
  const sb=getSupabase(); if(!sb) return false;
  NPC_SYNC_PAUSED=true;
  try{
    // V13.8.3: carrega SEMPRE do Supabase e limpa a memória local quando a tabela estiver vazia.
    // Não sobe dados de localStorage automaticamente para evitar que um navegador antigo contamine o banco.
    for(const name of ["suppliers","products","customers","messages","orders"]){
      const table=NPC_TABLES[name];
      const {data,error}=await sb.from(table).select("*").order("data_criacao",{ascending:true});
      if(error) throw error;
      NPC_MEMORY[name]=(data||[]).map(r=>dbToJs(name,r)).filter(Boolean);
    }
    await loadSettingsFromSupabase();
    setSyncStatus("Dados carregados diretamente do Supabase","success");
    return true;
  }catch(e){
    console.error("Erro ao carregar Supabase",e);
    setSyncStatus(`Erro ao carregar Supabase: ${e.message||e}`,"error");
    return false;
  }finally{
    NPC_SYNC_PAUSED=false;
    loadSettings();
    render();
  }
}
async function syncSettingsToSupabase(){
  const sb=getSupabase(); if(!sb) return;
  try{const valor=JSON.parse(localStorage.getItem(K.settings)||"{}"); await sb.from("configuracoes").upsert({chave:"loja",valor,data_atualizacao:new Date().toISOString()},{onConflict:"chave"});}catch(e){console.warn("Não foi possível sincronizar configurações",e);}
}
async function loadSettingsFromSupabase(){
  const sb=getSupabase(); if(!sb) return;
  try{const {data,error}=await sb.from("configuracoes").select("valor").eq("chave","loja").maybeSingle(); if(error) throw error; if(data?.valor) localStorage.setItem(K.settings,JSON.stringify(data.valor));}catch(e){console.warn("Não foi possível carregar configurações",e);}
}
async function logWhatsappHistory(o,t,finalText){
  const sb=getSupabase(); if(!sb || !o) return;
  try{await sb.from("historico_mensagens").insert({pedido_id:o.id||null,cliente_id:o.customerId||null,mensagem_id:t?.id||null,canal:"WhatsApp",telefone:o.customerPhone||null,texto_final:finalText||"",enviado_em:new Date().toISOString()});}catch(e){console.warn("Histórico WhatsApp não gravado",e);}
}
async function logCsvImport(info){
  const sb=getSupabase(); if(!sb) return;
  try{await sb.from("importacoes_csv").insert(info);}catch(e){console.warn("Importação CSV não registrada",e);}
}
async function logAiImport(jsonOriginal,pedidoId,produtoId){
  const sb=getSupabase(); if(!sb) return;
  try{await sb.from("importacoes_ia").insert({json_original:jsonOriginal||{},pedido_id:pedidoId||null,produto_id:produtoId||null,status:"importado",observacoes:"Importação pela tela Importar pedido da V13.8"});}catch(e){console.warn("Importação IA não registrada",e);}
}
async function logBackup(data,nomeArquivo){
  const sb=getSupabase(); if(!sb) return;
  try{await sb.from("backups").insert({nome_arquivo:nomeArquivo,conteudo:data,origem:"manual"});}catch(e){console.warn("Backup não registrado",e);}
}

const validPhone=p=>phone(p).length>=10;
const customerMatchKey=c=>{
  const name=cleanKey(c?.name);
  const location=[c?.cep,c?.address,c?.number,c?.city,c?.uf].filter(Boolean).join("|");
  if(!name || !cleanKey(location)) return "";
  return cleanKey([name,location].join("|"));
};
const orderCustomerMatchKey=o=>{
  const name=cleanKey(o?.customerName);
  const location=[o?.customerCep,o?.customerAddress,o?.customerNumber,o?.customerCity,o?.customerUf].filter(Boolean).join("|");
  if(!name || !cleanKey(location)) return "";
  return cleanKey([name,location].join("|"));
};
function sameCustomer(c,o){
  if(!c || !o) return false;
  // Regra principal: pedido gravado com customerId pertence somente ao cliente daquele ID.
  if(o.customerId || c.id) return !!(o.customerId && c.id && o.customerId===c.id);
  const cp=phone(c.phone), op=phone(o.customerPhone);
  if(validPhone(cp) && validPhone(op) && cp===op) return true;
  const ck=customerMatchKey(c), ok=orderCustomerMatchKey(o);
  return !!ck && !!ok && ck===ok;
}
function monthKey(date){
  const d=String(date||"");
  if(/^\d{4}-\d{2}/.test(d)) return d.slice(0,7);
  return "Sem data";
}
function monthLabel(key){
  if(key==="Sem data") return key;
  const [y,m]=String(key).split("-");
  return `${m}/${y}`;
}
function migrateV102(){
  const orders=read(K.orders);
  let changed=false;
  const fixedDates={
    "702-3700363-9714669":"2026-06-04",
    "702-9367159-1401849":"2026-06-05"
  };
  orders.forEach(o=>{
    if(fixedDates[o.amazonOrderId] && o.orderDate!==fixedDates[o.amazonOrderId]){
      o.orderDate=fixedDates[o.amazonOrderId];
      o.notes=String(o.notes||"").replace(/Data ajustada automaticamente pela V10.2. ?/g,"") + " Data ajustada automaticamente pela V10.2 usando a Data da compra do print Amazon.";
      changed=true;
    }
  });
  if(changed) write(K.orders,orders);
}
let orderPage=1;
let lastProductAutoFillQuery="";
let selectedPrintDataUrl="";

function seed(){
  if(localStorage.getItem(K.seeded)) return;
  const supplierId=uuid();
  const carrinhoId=uuid(), varalId=uuid(), customer1=uuid(), customer2=uuid();
  const msg1=uuid(), msg2=uuid(), msg3=uuid();
  write(K.suppliers,[{
    id:supplierId,name:"Fornecedor padrão - Frete zero",type:"Shopee",whatsapp:"",site:"https://shopee.com.br/",
    leadTime:"2 a 5 dias",status:"Ativo",notes:"Fornecedor exemplo usado na V10. Ajuste para seu fornecedor real."
  }]);
  write(K.products,[
    {
      id:carrinhoId,name:"Carrinho Organizador Multiuso 4 Camadas com Rodinhas Branco",category:"Casa e Organização",
      asin:"B0GXR5ZFF2",sku:"9L-GHWM-W32V",supplierId,buyLink:"https://shopee.com.br/",
      status:"Ativo na Amazon",buyPrice:40.04,buyShipping:0,salePrice:40.65,saleShipping:20.60,amazonFees:9.28,
      notes:"Exemplo V10: custo fornecedor R$ 40,04, frete fornecedor R$ 0, comissão Amazon R$ 9,28. Receita correta = produto vendido + frete cobrado do cliente."
    },
    {
      id:varalId,name:"Varal de Chão Dobrável 3 Andares com Rodinhas em Aço",category:"Casa e Lavanderia",
      asin:"B0GWS9T3DX",sku:"ZO-4NYQ-OMCM",supplierId,buyLink:"https://shopee.com.br/",
      status:"Ativo na Amazon",buyPrice:63.00,buyShipping:0,salePrice:65.80,saleShipping:30.10,amazonFees:11.51,
      notes:"Exemplo V10: custo médio fornecedor R$ 63,00, frete fornecedor R$ 0, comissão Amazon R$ 11,51."
    }
  ]);
  write(K.customers,[
    {id:customer1,name:"Ana",phone:"+5561986664715",cep:"20260050",address:"Rua Barão de Ubá",number:"184",complement:"Apartamento 103",district:"Praça da Bandeira",city:"Rio de Janeiro",uf:"RJ"},
    {id:customer2,name:"Rosa Daniele de Souza Oliveira",phone:"+5515997533752",cep:"18503130",address:"Rua Luiza Leite Gurian",number:"29",complement:"Apartamento 43",district:"Residencial 5 de Julho",city:"Laranjal Paulista",uf:"SP"}
  ]);
  write(K.messages,[
    {id:msg1,name:"Compra confirmada",type:"Compra confirmada",body:"Olá, {cliente}! Recebemos seu pedido {pedido} do produto {produto}. Obrigado por comprar na {loja}."},
    {id:msg2,name:"Envio de rastreio",type:"Rastreio",body:"Olá, {cliente}! Seu pedido {pedido} do produto {produto} já possui código de rastreio: {rastreio}. Obrigado pela compra. {loja}."},
    {id:msg3,name:"Entrega realizada",type:"Entrega realizada",body:"Olá, {cliente}! Vimos que o produto {produto} foi entregue. Esperamos que tenha gostado. Obrigado pela confiança na {loja}!"}
  ]);
  localStorage.setItem(K.settings, JSON.stringify({
    storeName:"Neo Prime Box",
    storeOwner:"José",
    storeWhatsapp:"+55 21 96869-2887",
    storeWhatsappMode:"web",
    storeMarketplace:"Amazon",
    storeColor:"Azul / Roxo",
    storeStatus:"Ativa",
    storeNotes:"Controle de vendas Amazon e dropshipping.",
    updatedAt:new Date().toISOString()
  }));
  write(K.orders,[
    {
      id:uuid(),orderDate:"2026-06-04",amazonOrderId:"702-3700363-9714669",productId:carrinhoId,productName:"Carrinho Organizador Multiuso 4 Camadas com Rodinhas Branco",
      customerId:customer1,customerName:"Ana",customerPhone:"+5561986664715",customerCep:"20260050",customerAddress:"Rua Barão de Ubá",
      customerNumber:"184",customerComplement:"Apartamento 103",customerDistrict:"Praça da Bandeira",customerCity:"Rio de Janeiro",customerUf:"RJ",
      supplierId,buyLink:"https://shopee.com.br/",status:"Venda realizada Amazon",salePrice:40.65,saleShipping:20.60,
      buyPrice:40.04,buyShipping:0,buyDiscount:0,amazonFees:9.28,trackingCode:"",trackingSent:"Não",messageTemplateId:msg2,
      notes:"Exemplo V10 baseado no print. Receita: R$ 61,25. Custo Amazon: R$ 9,28. Lucro líquido: R$ 11,93.",createdAt:new Date().toISOString()
    },
    {
      id:uuid(),orderDate:"2026-06-05",amazonOrderId:"702-9367159-1401849",productId:varalId,productName:"Varal de Chão Dobrável 3 Andares com Rodinhas em Aço",
      customerId:customer2,customerName:"Rosa Daniele de Souza Oliveira",customerPhone:"+5515997533752",customerCep:"18503130",customerAddress:"Rua Luiza Leite Gurian",
      customerNumber:"29",customerComplement:"Apartamento 43",customerDistrict:"Residencial 5 de Julho",customerCity:"Laranjal Paulista",customerUf:"SP",
      supplierId,buyLink:"https://shopee.com.br/",status:"Venda realizada Amazon",salePrice:65.80,saleShipping:30.10,
      buyPrice:63.00,buyShipping:0,buyDiscount:0,amazonFees:11.51,trackingCode:"",trackingSent:"Não",messageTemplateId:msg2,
      notes:"Exemplo V10 baseado no print. Receita: R$ 95,90. Custo Amazon: R$ 11,51. Lucro líquido usando custo médio R$ 63,00: R$ 21,39.",createdAt:new Date().toISOString()
    }
  ]);
  localStorage.setItem(K.seeded,"1");
}

function openView(view){
  document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active",v.id===view));
  document.querySelectorAll(".nav").forEach(n=>n.classList.toggle("active",n.dataset.view===view));
  updateSearchPlaceholder();
  render();
  window.scrollTo({top:0,behavior:"smooth"});
}
document.querySelectorAll("[data-view]").forEach(b=>b.onclick=()=>openView(b.dataset.view));
document.querySelectorAll("[data-view-open]").forEach(b=>b.onclick=()=>openView(b.dataset.viewOpen));
document.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();$("globalSearch").focus();}});

function phone(p){let d=String(p||"").replace(/\D/g,"");return d?d.startsWith("55")?d:"55"+d:"";}
function supplierName(id){return read(K.suppliers).find(s=>s.id===id)?.name||"-";}
function productName(id){return read(K.products).find(p=>p.id===id)?.name||"-";}
function activeView(){return document.querySelector(".view.active")?.id || "dashboard";}
function searchQuery(){return cleanKey($("globalSearch")?.value || "");}
function textMatch(blob,q=searchQuery()){return !q || cleanKey(blob).includes(q);}
function sortByName(arr, field="name"){
  return [...(arr||[])].sort((a,b)=>String(a?.[field]||"").localeCompare(String(b?.[field]||""), "pt-BR", {sensitivity:"base"}));
}
function optionLabelSafe(v){return esc(String(v||""));}
function updateSearchPlaceholder(){
  const map={
    dashboard:"Buscar pedidos recentes, produtos, clientes...",
    orders:"Buscar pedido, produto, cliente, fornecedor ou status...",
    products:"Buscar produto, ASIN, SKU, categoria ou fornecedor...",
    customers:"Buscar cliente, telefone, CEP, cidade ou endereço...",
    suppliers:"Buscar fornecedor, tipo, WhatsApp ou prazo...",
    messages:"Buscar mensagem, tipo ou texto...",
    finance:"Buscar financeiro por pedido, cliente, produto ou fornecedor...",
    reports:"Buscar relatórios por produto ou fornecedor...",
    analytics:"Buscar análises por produto, cliente ou fornecedor...",
    aiImport:"Buscar não se aplica aqui. Use para navegar nas listas.",
    csvImport:"Buscar não se aplica aqui. Use para navegar nas listas.",
    settings:"Buscar não se aplica aqui. Use para navegar nas listas."
  };
  if($("globalSearch")) $("globalSearch").placeholder=map[activeView()] || "Buscar...";
}

function filteredOrders(){
  const q=searchQuery();
  const period=$("globalPeriod").value;
  const status=$("ordersStatusFilter")?.value || "all";
  const now=new Date(); const t=today();
  return read(K.orders).filter(o=>{
    const blob=`${o.amazonOrderId} ${o.productName} ${o.customerName} ${o.customerPhone||""} ${o.customerCep||""} ${o.customerCity||""} ${supplierName(o.supplierId)} ${o.status} ${o.trackingCode||""}`;
    if(!textMatch(blob,q)) return false;
    if(status!=="all" && o.status!==status) return false;
    if(period==="today") return o.orderDate===t;
    if(period==="7days"){let d=new Date(`${o.orderDate}T00:00:00`);let s=new Date();s.setDate(now.getDate()-7);return d>=s;}
    if(period==="month") return String(o.orderDate||"").slice(0,7)===t.slice(0,7);
    return true;
  }).sort((a,b)=>String(b.orderDate).localeCompare(String(a.orderDate)));
}
function groupBy(arr,keyFn){
  const m={}; arr.forEach(x=>{const k=keyFn(x)||"Não informado";m[k]??=[];m[k].push(x)}); return m;
}
function productStats(){
  const m={};
  read(K.orders).forEach(o=>{
    const k=o.productName||productName(o.productId);
    m[k]??={name:k,qty:0,rev:0,profit:0};
    m[k].qty++; m[k].rev+=revenue(o); m[k].profit+=profit(o);
  });
  return Object.values(m).sort((a,b)=>b.qty-a.qty || b.profit-a.profit);
}
function supplierStats(){
  const m={};
  read(K.orders).forEach(o=>{
    const k=supplierName(o.supplierId);
    m[k]??={name:k,qty:0,rev:0,profit:0};
    m[k].qty++; m[k].rev+=revenue(o); m[k].profit+=profit(o);
  });
  return Object.values(m).sort((a,b)=>b.profit-a.profit);
}
function categoryStats(){
  const products=read(K.products);
  const m={};
  read(K.orders).forEach(o=>{
    const p=products.find(x=>x.id===o.productId);
    const k=p?.category || "Sem categoria";
    m[k]??={name:k,qty:0,rev:0};
    m[k].qty++;m[k].rev+=revenue(o);
  });
  return Object.values(m).sort((a,b)=>b.rev-a.rev);
}

function renderDashboard(){
  const orders=filteredOrders();
  const rev=orders.reduce((s,o)=>s+revenue(o),0), co=orders.reduce((s,o)=>s+cost(o),0), prof=orders.reduce((s,o)=>s+profit(o),0);
  $("kpiRevenue").textContent=brl(rev); $("kpiProfit").textContent=brl(prof); $("kpiOrders").textContent=orders.length;
  $("kpiTicket").textContent=brl(orders.length?rev/orders.length:0); $("kpiMargin").textContent=rev?`${(prof/rev*100).toFixed(1)}%`:"0%";
  $("sumRevenue").textContent=brl(rev); $("sumBuy").textContent=brl(orders.reduce((s,o)=>s+supplierOrderCost(o),0));
  $("sumBuyShipping").textContent=brl(orders.reduce((s,o)=>s+num(o.buyShipping),0)); $("sumFees").textContent=brl(orders.reduce((s,o)=>s+num(o.amazonFees),0));
  $("sumProfit").textContent=brl(prof); $("sumMargin").textContent=rev?`${(prof/rev*100).toFixed(1)}%`:"0%";

  $("recentOrders").innerHTML=orders.slice(0,5).map(o=>`<div class="recentItem">
    <span class="amazonIcon">a</span><div><strong>${o.customerName}</strong><small>${o.amazonOrderId}</small></div>
    <div class="recentMoney">${brl(revenue(o))}<br><span class="status ${statusClass(o.status)}">${o.status}</span></div>
  </div>`).join("") || "<p class='muted'>Nenhum pedido encontrado.</p>";

  const top=productStats();
  $("topProductsDash").innerHTML=top.slice(0,5).map((p,i)=>`<div class="rankItem"><span class="rankNo">${i+1}</span><div><strong>${p.name}</strong><small>${p.qty} venda(s)</small></div><span class="rankMoney">${brl(p.profit)}</span></div>`).join("") || "<p class='muted'>Sem produtos vendidos.</p>";

  renderSalesChart(orders);
  renderCategoryChart(categoryStats());
  renderProfitBars(top);
}
function statusClass(s){s=(s||"").toLowerCase(); if(s.includes("entregue")||s.includes("enviado ao cliente"))return"entregue"; if(s.includes("aguardando"))return"aguardando"; if(s.includes("cancelado")||s.includes("devolvido")||s.includes("reembolsado"))return"cancelado"; return"";}

function renderSalesChart(orders){
  const c=$("salesChart"), ctx=c.getContext("2d"), w=c.width, h=c.height;
  ctx.clearRect(0,0,w,h); ctx.fillStyle="#0b1428"; ctx.fillRect(0,0,w,h);
  const days=[...Array(7)].map((_,i)=>{let d=new Date();d.setDate(d.getDate()-(6-i));return d.toISOString().slice(0,10);});
  const sales=days.map(d=>orders.filter(o=>o.orderDate===d).reduce((s,o)=>s+revenue(o),0));
  const profits=days.map(d=>orders.filter(o=>o.orderDate===d).reduce((s,o)=>s+profit(o),0));
  const max=Math.max(100,...sales,...profits);
  ctx.strokeStyle="rgba(255,255,255,.08)";ctx.lineWidth=1;ctx.font="13px Arial";ctx.fillStyle="#98a6c6";
  for(let i=0;i<5;i++){let y=35+i*(h-70)/4;ctx.beginPath();ctx.moveTo(45,y);ctx.lineTo(w-20,y);ctx.stroke();}
  function line(data,color){ctx.strokeStyle=color;ctx.lineWidth=4;ctx.beginPath();data.forEach((v,i)=>{let x=55+i*(w-95)/6;let y=h-35-(v/max)*(h-80);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();data.forEach((v,i)=>{let x=55+i*(w-95)/6;let y=h-35-(v/max)*(h-80);ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,5,0,Math.PI*2);ctx.fill();});}
  line(sales,"#2563ff"); line(profits,"#b32dff");
  days.forEach((d,i)=>{let x=45+i*(w-95)/6;ctx.fillStyle="#98a6c6";ctx.fillText(d.slice(5).split("-").reverse().join("/"),x,h-10);});
  ctx.fillStyle="#2563ff";ctx.fillRect(55,15,18,9);ctx.fillStyle="#fff";ctx.fillText("Vendas",80,23);ctx.fillStyle="#b32dff";ctx.fillRect(150,15,18,9);ctx.fillStyle="#fff";ctx.fillText("Lucro",175,23);
}
function renderCategoryChart(stats){
  const c=$("categoryChart"), ctx=c.getContext("2d"), w=c.width,h=c.height;ctx.clearRect(0,0,w,h);
  const colors=["#1fa2ff","#7c2cff","#ffb020","#e647d4","#22e58d"]; const total=stats.reduce((s,x)=>s+x.rev,0)||1;
  let start=-Math.PI/2, cx=115, cy=130, r=82;
  stats.slice(0,5).forEach((s,i)=>{let ang=(s.rev/total)*Math.PI*2;ctx.beginPath();ctx.moveTo(cx,cy);ctx.fillStyle=colors[i];ctx.arc(cx,cy,r,start,start+ang);ctx.closePath();ctx.fill();start+=ang;});
  ctx.globalCompositeOperation="destination-out";ctx.beginPath();ctx.arc(cx,cy,42,0,Math.PI*2);ctx.fill();ctx.globalCompositeOperation="source-over";
  $("categoryLegend").innerHTML=stats.slice(0,5).map((s,i)=>`<span><i style="background:${colors[i]}"></i>${s.name} ${Math.round(s.rev/total*100)}%</span>`).join("");
}
function renderProfitBars(stats){
  const max=Math.max(1,...stats.map(s=>s.profit));
  $("profitBars").innerHTML=stats.slice(0,5).map(s=>`<div class="barRow"><span>${s.name}</span><div class="barTrack"><div class="barFill" style="width:${Math.max(5,s.profit/max*100)}%"></div></div><b>${brl(s.profit)}</b></div>`).join("") || "<p class='muted'>Sem dados.</p>";
}


function renderAmazonMetrics(){
  const orders=read(K.orders);
  const t=today();
  const now=new Date();
  const weekStart=new Date(); weekStart.setDate(now.getDate()-7);
  const todayOrders=orders.filter(o=>o.orderDate===t);
  const weekOrders=orders.filter(o=>new Date(`${o.orderDate}T00:00:00`)>=weekStart);
  const monthOrders=orders.filter(o=>String(o.orderDate||"").slice(0,7)===t.slice(0,7));
  const champion=productStats()[0];

  $("metricToday").textContent=brl(todayOrders.reduce((s,o)=>s+revenue(o),0));
  $("metricTodayOrders").textContent=`${todayOrders.length} pedido(s)`;
  $("metricWeek").textContent=brl(weekOrders.reduce((s,o)=>s+revenue(o),0));
  $("metricWeekProfit").textContent=`Lucro ${brl(weekOrders.reduce((s,o)=>s+profit(o),0))}`;
  $("metricMonth").textContent=brl(monthOrders.reduce((s,o)=>s+revenue(o),0));
  $("metricMonthProfit").textContent=`Lucro ${brl(monthOrders.reduce((s,o)=>s+profit(o),0))}`;
  $("metricChampion").textContent=champion?.name || "-";
  $("metricChampionSub").textContent=champion ? `${champion.qty} venda(s) | ${brl(champion.profit)} lucro` : "0 venda(s)";
}

function renderSelects(){
  const suppliers=sortByName(read(K.suppliers));
  const products=sortByName(read(K.products).filter(p=>p.status!=="Arquivado"));
  const customers=sortByName(read(K.customers));
  const messages=sortByName(read(K.messages));
  const supplierOpts='<option value="">Selecione...</option>'+suppliers.map(s=>`<option value="${s.id}">${optionLabelSafe(s.name)}</option>`).join("");
  const productOpts='<option value="">Selecione...</option>'+products.map(p=>`<option value="${p.id}">${optionLabelSafe(p.name)}</option>`).join("");
  const customerOpts='<option value="">Novo cliente</option>'+customers.map(c=>`<option value="${c.id}">${optionLabelSafe(c.name)} — ${optionLabelSafe(c.phone||"sem telefone")}</option>`).join("");
  const messageOpts=messages.map(m=>`<option value="${m.id}">${optionLabelSafe(m.name)}</option>`).join("");
  ["orderSupplierId","productSupplierId","aiSupplierId","csvDefaultSupplier"].forEach(id=>{if($(id)) $(id).innerHTML=supplierOpts;});
  if($("orderProductId")) $("orderProductId").innerHTML=productOpts;
  if($("orderCustomerId")) $("orderCustomerId").innerHTML=customerOpts;
  ["messageTemplateId","aiMessageTemplateId"].forEach(id=>{if($(id)) $(id).innerHTML=messageOpts;});
}

$("orderProductId").onchange=()=>{
  const p=read(K.products).find(x=>x.id===$("orderProductId").value);
  if(!p)return;
  $("orderSupplierId").value=p.supplierId||"";
  $("buyLink").value=p.buyLink||"";
  $("buyPrice").value=p.buyPrice||0;
  $("buyShipping").value=p.buyShipping||0;
  $("salePrice").value=p.salePrice||0;
  $("saleShipping").value=p.saleShipping||0;
  $("amazonFees").value=p.amazonFees||0;
  updateOrderCalcPreview();
};
$("orderCustomerId").onchange=()=>{const c=read(K.customers).find(x=>x.id===$("orderCustomerId").value);if(!c)return;["Name","Phone","Cep","Address","Number","Complement","District","City","Uf"].forEach(f=>{$("customer"+f).value=c[f.toLowerCase()]||c[f.charAt(0).toLowerCase()+f.slice(1)]||""});};
$("cepBtn").onclick=async()=>{const cep=$("customerCep").value.replace(/\D/g,""); if(cep.length!==8)return alert("Digite um CEP com 8 números."); try{const r=await fetch(`https://viacep.com.br/ws/${cep}/json/`);const d=await r.json();if(d.erro)return alert("CEP não encontrado.");$("customerAddress").value=d.logradouro||"";$("customerComplement").value=d.complemento||"";$("customerDistrict").value=d.bairro||"";$("customerCity").value=d.localidade||"";$("customerUf").value=d.uf||"";}catch(e){alert("Não foi possível consultar o CEP.");}};

function upsertCustomer(o){
  let arr=read(K.customers);
  const p=phone(o.customerPhone);
  let ix=-1;
  if(validPhone(p)) ix=arr.findIndex(c=>validPhone(c.phone) && phone(c.phone)===p);
  if(ix<0){
    const ok=orderCustomerMatchKey(o);
    if(ok) ix=arr.findIndex(c=>customerMatchKey(c)===ok);
  }
  const c={id:ix>=0?arr[ix].id:uuid(),name:o.customerName,phone:o.customerPhone,cep:o.customerCep,address:o.customerAddress,number:o.customerNumber,complement:o.customerComplement,district:o.customerDistrict,city:o.customerCity,uf:o.customerUf};
  ix>=0?arr[ix]=c:arr.push(c);write(K.customers,arr);return c.id;
}
function cleanKey(v){return String(v||"").trim().toLowerCase();}
// V13.8.4 - chave de comparação de produto mais rígida por ASIN/SKU e nome limpo.
// Objetivo: não criar produto novo quando o mesmo item aparecer em vários pedidos/importações.
function normalizeProductName(v){
  return String(v||"")
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase()
    .replace(/\b\d{3}-\d{7}-\d{7}\b/g," ") // pedido Amazon 701-...
    .replace(/\b(?:pedido|order|id|venda|compra|amazon)\s*[:#-]?\s*\d{3,}(?:[-\d]+)?\b/g," ")
    .replace(/\b(?:sku|asin)\s*[:#-]?\s*[a-z0-9-]+\b/g," ")
    .replace(/[^a-z0-9]+/g," ")
    .replace(/\s+/g," ")
    .trim();
}
function productTokens(v){
  return normalizeProductName(v).split(" ").filter(t=>t.length>1 && !["de","da","do","das","dos","com","para","por","sem","em","a","o","e"].includes(t));
}
function tokenSimilarity(a,b){
  const ta=[...new Set(productTokens(a))], tb=[...new Set(productTokens(b))];
  if(!ta.length || !tb.length) return 0;
  const small=ta.length<=tb.length?ta:tb, big=ta.length<=tb.length?tb:ta;
  const hits=small.filter(t=>big.includes(t)).length;
  return hits/small.length;
}
function sameProductName(a,b){
  const na=normalizeProductName(a), nb=normalizeProductName(b);
  if(!na || !nb) return false;
  if(na===nb) return true;
  // Evita duplicar quando uma importação vem com pequenas variações no título.
  if(Math.min(na.length,nb.length)>=16 && (na.includes(nb) || nb.includes(na))) return true;
  return tokenSimilarity(na,nb)>=0.92;
}
function sameSkuOrAsin(product, d){
  const asinA=cleanKey(product?.asin), asinB=cleanKey(d?.asin);
  const skuA=cleanKey(product?.sku), skuB=cleanKey(d?.sku);
  return (!!asinA && !!asinB && asinA===asinB) || (!!skuA && !!skuB && skuA===skuB);
}
function normalizeOrderId(v){return String(v||"").replace(/\s+/g,"").trim().toLowerCase();}
function normalizeDate(v){return String(v||"").slice(0,10);}
function duplicateOrderKey(o){return `${normalizeOrderId(o.amazonOrderId)}|${cleanKey(o.productId || o.productName)}|${normalizeDate(o.orderDate)}`;}
function findDuplicateOrder(candidate, arr, excludeId=""){
  const candOrder=normalizeOrderId(candidate.amazonOrderId);
  const candProduct=cleanKey(candidate.productId || candidate.productName);
  const candDate=normalizeDate(candidate.orderDate);
  if(!candOrder) return null;
  return arr.find(o=>{
    if(excludeId && o.id===excludeId) return false;
    const sameOrder=normalizeOrderId(o.amazonOrderId)===candOrder;
    const sameProduct=cleanKey(o.productId || o.productName)===candProduct;
    const sameDate=normalizeDate(o.orderDate)===candDate;
    return sameOrder && sameProduct && sameDate;
  }) || null;
}
function duplicateWarningText(dup){
  return `Venda possivelmente já registrada.\n\nPedido: ${dup.amazonOrderId||"-"}\nProduto: ${dup.productName||"-"}\nData da compra: ${dup.orderDate||"-"}\n\nCancelar para evitar duplicidade. OK para registrar mesmo assim.`;
}
function confirmIfDuplicate(candidate, arr, excludeId=""){
  const dup=findDuplicateOrder(candidate, arr, excludeId);
  return !dup || confirm(duplicateWarningText(dup));
}
function orderFromForm(){
  const p=read(K.products).find(x=>x.id===$("orderProductId").value);
  return {id:$("orderId").value||uuid(),orderDate:$("orderDate").value,amazonOrderId:$("amazonOrderId").value,productId:$("orderProductId").value,productName:p?.name||"",customerId:$("orderCustomerId").value,customerName:$("customerName").value,customerPhone:$("customerPhone").value,customerCep:$("customerCep").value,customerAddress:$("customerAddress").value,customerNumber:$("customerNumber").value,customerComplement:$("customerComplement").value,customerDistrict:$("customerDistrict").value,customerCity:$("customerCity").value,customerUf:$("customerUf").value,supplierId:$("orderSupplierId").value,buyLink:$("buyLink").value,status:$("orderStatus").value,salePrice:num($("salePrice").value),saleShipping:num($("saleShipping").value),buyPrice:num($("buyPrice").value),buyShipping:num($("buyShipping").value),buyDiscount:num($("buyDiscount").value),amazonFees:num($("amazonFees").value),trackingCode:$("trackingCode").value,trackingSent:$("trackingSent").value,messageTemplateId:$("messageTemplateId").value,notes:$("orderNotes").value,updatedAt:new Date().toISOString()};
}
$("orderForm").onsubmit=e=>{e.preventDefault();let arr=read(K.orders);let o=orderFromForm();let ix=arr.findIndex(x=>x.id===o.id);if(ix<0 && !confirmIfDuplicate(o,arr,o.id)) return;o.customerId=upsertCustomer(o);ix>=0?arr[ix]=o:arr.push({...o,createdAt:new Date().toISOString()});write(K.orders,arr);clearOrder();render();};
function clearOrder(){ $("orderForm").reset(); $("orderId").value=""; $("orderFormTitle").textContent="Novo pedido Amazon"; $("orderDate").value=today(); ["saleShipping","buyShipping","buyDiscount","amazonFees"].forEach(id=>$(id).value=0);}
$("clearOrderBtn").onclick=clearOrder;$("newOrderBtn").onclick=()=>{clearOrder();document.querySelector(".formPanel").scrollIntoView({behavior:"smooth"});}
function editOrder(id){const o=read(K.orders).find(x=>x.id===id);if(!o)return;const map={orderId:o.id,orderDate:o.orderDate,amazonOrderId:o.amazonOrderId,orderProductId:o.productId,orderCustomerId:o.customerId,customerName:o.customerName,customerPhone:o.customerPhone,customerCep:o.customerCep,customerAddress:o.customerAddress,customerNumber:o.customerNumber,customerComplement:o.customerComplement,customerDistrict:o.customerDistrict,customerCity:o.customerCity,customerUf:o.customerUf,orderSupplierId:o.supplierId,buyLink:o.buyLink,orderStatus:o.status,salePrice:o.salePrice,saleShipping:o.saleShipping,buyPrice:o.buyPrice,buyShipping:o.buyShipping,buyDiscount:o.buyDiscount,amazonFees:o.amazonFees,trackingCode:o.trackingCode,trackingSent:o.trackingSent,messageTemplateId:o.messageTemplateId,orderNotes:o.notes};Object.entries(map).forEach(([k,v])=>{if($(k))$(k).value=v||""});$("orderFormTitle").textContent="Editar pedido Amazon";openView("orders");document.querySelector(".formPanel").scrollIntoView({behavior:"smooth"});}
function delOrder(id){if(confirm("Excluir pedido?")){write(K.orders,read(K.orders).filter(o=>o.id!==id));render();}}
function markSent(id){write(K.orders,read(K.orders).map(o=>o.id===id?{...o,trackingSent:"Sim",status:"Código enviado ao cliente"}:o));render();}
function messageText(t,o){return String(t?.body||"").replaceAll("{cliente}",o.customerName||"").replaceAll("{produto}",o.productName||"").replaceAll("{pedido}",o.amazonOrderId||"").replaceAll("{rastreio}",o.trackingCode||"").replaceAll("{loja}",STORE);}
function waBaseLink(o,t){const p=phone(o?.customerPhone);if(!p)return"";return`https://wa.me/${p}?text=${encodeURIComponent(messageText(t,o))}`;}
let pendingWhatsappOrderId="";
function sendWa(id){
  const o=read(K.orders).find(x=>x.id===id);
  if(!o) return;
  if(!phone(o.customerPhone)) return alert("Pedido sem telefone/WhatsApp.");
  pendingWhatsappOrderId=id;
  const msgs=read(K.messages);
  const defaultId=o.messageTemplateId || msgs[0]?.id || "";
  if($("waMessageSelect")){
    $("waMessageSelect").innerHTML=msgs.map(m=>`<option value="${m.id}" ${m.id===defaultId?'selected':''}>${esc(m.name)} · ${esc(m.type||'Mensagem')}</option>`).join("");
    $("waPreviewOrder").textContent=`Cliente: ${o.customerName||'-'} • Pedido: ${o.amazonOrderId||'-'} • Produto: ${o.productName||'-'}`;
    const t=msgs.find(m=>m.id===defaultId)||msgs[0];
    $("waMessagePreview").value=messageText(t,o);
    $("whatsappMessageModal").style.display="grid";
  }
}
function refreshWaPreview(){
  const o=read(K.orders).find(x=>x.id===pendingWhatsappOrderId);
  const t=read(K.messages).find(m=>m.id===$("waMessageSelect")?.value);
  if(o && t && $("waMessagePreview")) $("waMessagePreview").value=messageText(t,o);
}
function confirmWhatsappMessage(){
  const o=read(K.orders).find(x=>x.id===pendingWhatsappOrderId);
  const t=read(K.messages).find(m=>m.id===$("waMessageSelect")?.value);
  const link=waBaseLink(o,t);
  if(!link) return alert("Pedido sem telefone/WhatsApp.");
  const finalText=messageText(t,o);
  logWhatsappHistory(o,t,finalText);
  $("whatsappMessageModal").style.display="none";
  window.open(link,"_blank");
}
function closeWhatsappMessage(){ if($("whatsappMessageModal")) $("whatsappMessageModal").style.display="none"; }

function testStoreWhatsapp(){
  const st=JSON.parse(localStorage.getItem(K.settings)||"{}");
  const storePhone=phone(st.storeWhatsapp||$("storeWhatsapp")?.value||"");
  if(!storePhone) return alert("Configure o WhatsApp da loja antes de testar.");
  const msg=`Teste de configuração do WhatsApp da ${st.storeName||STORE}. Confira se o WhatsApp Web está logado no número da loja antes de enviar mensagens aos clientes.`;
  window.open(`https://web.whatsapp.com/send?phone=${storePhone}&text=${encodeURIComponent(msg)}`,"_blank");
}

function sendTrackingWa(id){
  const o=read(K.orders).find(x=>x.id===id);
  if(!o) return;
  if(!o.trackingCode) return alert("Este pedido ainda não tem código de rastreio.");
  const p=phone(o.customerPhone);
  if(!p) return alert("Pedido sem telefone.");
  const text=`Olá, ${o.customerName}! Tudo bem? Seu pedido ${o.amazonOrderId} do produto ${o.productName} já possui código de rastreio: ${o.trackingCode}. Obrigado pela compra. Neo Prime Box.`;
  window.open(`https://wa.me/${p}?text=${encodeURIComponent(text)}`,"_blank");
  write(K.orders,read(K.orders).map(x=>x.id===id?{...x,trackingSent:"Sim",status:"Código enviado ao cliente"}:x));
  render();
}

function renderOrdersFinancialCards(all){
  if(!$("ordersRevenueTotal")) return;
  const rev=all.reduce((s,o)=>s+revenue(o),0);
  const amazon=all.reduce((s,o)=>s+num(o.amazonFees),0);
  const supplier=all.reduce((s,o)=>s+supplierOrderCost(o),0);
  const prof=all.reduce((s,o)=>s+profit(o),0);
  $("ordersRevenueTotal").textContent=brl(rev);
  $("ordersAmazonTotal").textContent=brl(amazon);
  $("ordersSupplierTotal").textContent=brl(supplier);
  $("ordersProfitTotal").textContent=brl(prof);
  $("ordersMarginAverage").textContent=rev?`${(prof/rev*100).toFixed(1)}%`:"0%";
}
function renderOrdersTable(){
  const all=filteredOrders();
  renderOrdersFinancialCards(all);
  const pageSize=num($("ordersPageSize").value)||25; const totalPages=Math.max(1,Math.ceil(all.length/pageSize)); if(orderPage>totalPages)orderPage=totalPages;
  const rows=all.slice((orderPage-1)*pageSize,orderPage*pageSize);
  $("ordersTable").innerHTML=rows.map(o=>{
    const rev=revenue(o), amazon=num(o.amazonFees), supplier=supplierOrderCost(o), prof=profit(o), m=margin(prof,rev);
    return `<tr><td>${o.orderDate||"-"}<br><small>Data da compra</small></td><td><b>${o.amazonOrderId||"-"}</b></td><td>${o.productName||"-"}<br><small>${supplierName(o.supplierId)}</small></td><td>${o.customerName||"-"}<br><small>${o.customerCity||""}/${o.customerUf||""}</small></td><td><span class="status ${statusClass(o.status)}">${o.status}</span></td><td>${brl(rev)}</td><td class="moneyAmazon">${amazonFeeDisplay(o)}</td><td>${brl(supplier)}</td><td class="success">${brl(prof)}</td><td><span class="marginBadge ${marginClass(m)}">${m.toFixed(1)}%</span></td><td>${o.trackingCode||"<small>pendente</small>"}<br><small>Enviado: ${o.trackingSent}</small></td><td><div class="actionGroup"><button onclick="editOrder('${o.id}')">Editar</button><button onclick="sendWa('${o.id}')">WhatsApp</button><button onclick="sendTrackingWa('${o.id}')">Enviar rastreio</button><button onclick="markSent('${o.id}')">Rastreio enviado</button><button class="danger" onclick="delOrder('${o.id}')">Excluir</button></div></td></tr>`;
  }).join("");
  $("ordersPagination").innerHTML=[...Array(totalPages)].map((_,i)=>`<button class="${i+1===orderPage?'active':''}" onclick="orderPage=${i+1};renderOrdersTable()">${i+1}</button>`).join("");
}

function productFromForm(){return{id:$("productId").value||uuid(),name:$("productName").value,category:$("productCategory").value,asin:$("productAsin").value,sku:$("productSku").value,supplierId:$("productSupplierId").value,buyLink:$("productBuyLink").value,status:$("productStatus").value,buyPrice:num($("productBuyPrice").value),buyShipping:num($("productBuyShipping").value),salePrice:num($("productSalePrice").value),saleShipping:num($("productSaleShipping").value),amazonFees:num($("productAmazonFees").value),notes:$("productNotes").value};}
$("productForm").onsubmit=e=>{e.preventDefault();let arr=read(K.products), p=productFromForm(), ix=arr.findIndex(x=>x.id===p.id);ix>=0?arr[ix]=p:arr.push(p);write(K.products,arr);clearProduct();render();};
function clearProduct(){$("productForm").reset();$("productId").value="";$("productFormTitle").textContent="Produto do catálogo";["productBuyPrice","productBuyShipping","productSalePrice","productSaleShipping","productAmazonFees"].forEach(id=>$(id).value=0);updateProductCalcPreview();}
$("clearProductBtn").onclick=clearProduct;
function fillProductForm(p, mode="manual"){
  if(!p) return;
  const map={productId:p.id,productName:p.name,productCategory:p.category,productAsin:p.asin,productSku:p.sku,productSupplierId:p.supplierId,productBuyLink:p.buyLink,productStatus:p.status,productBuyPrice:p.buyPrice,productBuyShipping:p.buyShipping,productSalePrice:p.salePrice,productSaleShipping:p.saleShipping,productAmazonFees:p.amazonFees,productNotes:p.notes};
  Object.entries(map).forEach(([k,v])=>{if($(k))$(k).value=v??""});
  if($("productFormTitle")) $("productFormTitle").textContent=mode==="search"?"Produto encontrado na busca":"Editar produto";
  updateProductCalcPreview();
}
function editProduct(id){const p=read(K.products).find(x=>x.id===id);if(!p)return;fillProductForm(p,"manual");openView("products");}
function delProduct(id){if(confirm("Excluir produto? Recomendo arquivar se já houve vendas.")){write(K.products,read(K.products).filter(p=>p.id!==id));render();}}
function archiveProduct(id){write(K.products,read(K.products).map(p=>p.id===id?{...p,status:"Arquivado"}:p));render();}
function renderProducts(){
  const f=$("productStatusFilter").value; const orders=read(K.orders); const q=searchQuery();
  const rows=sortByName(read(K.products).filter(p=>{
    const blob=`${p.name} ${p.category||""} ${p.asin||""} ${p.sku||""} ${supplierName(p.supplierId)} ${p.status||""} ${p.notes||""}`;
    return (f==="all"||p.status===f) && textMatch(blob,q);
  }));
  if(activeView()==="products" && q.length>=2 && rows.length){
    // V13.7: a busca global de Produtos carrega o melhor resultado no formulário e leva o usuário ao formulário.
    const exact=rows.find(p=>[p.name,p.asin,p.sku].some(v=>cleanKey(v)===q));
    const starts=rows.find(p=>[p.name,p.asin,p.sku].some(v=>cleanKey(v).startsWith(q)));
    const contains=rows.find(p=>[p.name,p.asin,p.sku,p.category].some(v=>cleanKey(v).includes(q)));
    const target=exact || starts || contains || rows[0];
    if(target && $("productId")){
      const changed=$("productId").value!==target.id || lastProductAutoFillQuery!==q;
      fillProductForm(target,"search");
      lastProductAutoFillQuery=q;
      const panel=$("productForm")?.closest(".panel");
      if(changed && panel) setTimeout(()=>panel.scrollIntoView({behavior:"smooth",block:"start"}), 50);
    }
  }
  $("productsTable").innerHTML=rows.map(p=>{const po=orders.filter(o=>o.productId===p.id);const avg=po.length?po.reduce((s,o)=>s+profit(o),0)/po.length:productExpectedProfit(p);return`<tr><td><b>${p.name}</b><br><small>ASIN: ${p.asin||"-"} | SKU: ${p.sku||"-"}</small></td><td>${p.category||"-"}</td><td>${supplierName(p.supplierId)}</td><td><span class="status">${p.status}</span></td><td>${brl(productCost(p))}</td><td>${brl(p.amazonFees)}</td><td>${brl(productRevenue(p))}</td><td class="success">${brl(avg)}</td><td><div class="actionGroup"><button onclick="editProduct('${p.id}')">Editar</button><button onclick="archiveProduct('${p.id}')">Arquivar</button><button class="danger" onclick="delProduct('${p.id}')">Excluir</button></div></td></tr>`}).join("") || `<tr><td colspan="9"><small>Nenhum produto encontrado para essa busca.</small></td></tr>`;
}

$("supplierForm").onsubmit=e=>{e.preventDefault();let arr=read(K.suppliers);let s={id:$("supplierId").value||uuid(),name:$("supplierName").value,type:$("supplierType").value,contact:$("supplierContact")?.value||"",phone:$("supplierWhatsapp").value,whatsapp:$("supplierWhatsapp").value,email:$("supplierEmail")?.value||"",site:$("supplierSite").value,leadTime:$("supplierLeadTime").value,status:$("supplierStatus").value,notes:$("supplierNotes").value};let ix=arr.findIndex(x=>x.id===s.id);ix>=0?arr[ix]=s:arr.push(s);write(K.suppliers,arr);clearSupplier();render();};
function clearSupplier(){$("supplierForm").reset();$("supplierId").value="";$("supplierFormTitle").textContent="Fornecedor";}
$("clearSupplierBtn").onclick=clearSupplier;
function editSupplier(id){const s=read(K.suppliers).find(x=>x.id===id);if(!s)return;["Id","Name","Type","Whatsapp","Site","LeadTime","Status","Notes"].forEach(f=>{if($("supplier"+f)) $("supplier"+f).value=s[f.charAt(0).toLowerCase()+f.slice(1)]||""});if($("supplierContact")) $("supplierContact").value=s.contact||s.contato||"";if($("supplierEmail")) $("supplierEmail").value=s.email||"";$("supplierFormTitle").textContent="Editar fornecedor";openView("suppliers");}
function delSupplier(id){if(confirm("Excluir fornecedor?")){write(K.suppliers,read(K.suppliers).filter(s=>s.id!==id));render();}}
function renderSuppliers(){
  const products=read(K.products), orders=read(K.orders); const q=searchQuery();
  const rows=read(K.suppliers).filter(s=>textMatch(`${s.name} ${s.type||""} ${s.contact||""} ${s.phone||""} ${s.whatsapp||""} ${s.email||""} ${s.site||""} ${s.leadTime||""} ${s.status||""} ${s.notes||""}`,q));
  $("suppliersTable").innerHTML=rows.map(s=>`<tr><td><b>${s.name}</b><br><small>${s.status}</small></td><td>${s.type}</td><td>${s.contact||"-"}</td><td>${s.phone||s.whatsapp||"-"}</td><td>${s.email||"-"}</td><td>${s.leadTime||"-"}</td><td>${products.filter(p=>p.supplierId===s.id).length}</td><td>${orders.filter(o=>o.supplierId===s.id).length}</td><td><div class="actionGroup"><button onclick="editSupplier('${s.id}')">Editar</button><button class="danger" onclick="delSupplier('${s.id}')">Excluir</button></div></td></tr>`).join("") || `<tr><td colspan="9"><small>Nenhum fornecedor encontrado para essa busca.</small></td></tr>`;
}

$("messageForm").onsubmit=e=>{e.preventDefault();let arr=read(K.messages);let m={id:$("messageId").value||uuid(),name:$("messageName").value,type:$("messageType").value,body:$("messageBody").value};let ix=arr.findIndex(x=>x.id===m.id);ix>=0?arr[ix]=m:arr.push(m);write(K.messages,arr);clearMessage();render();};
function clearMessage(){$("messageForm").reset();$("messageId").value="";$("messageFormTitle").textContent="Mensagem padrão";}
$("clearMessageBtn").onclick=clearMessage;
function editMessage(id){const m=read(K.messages).find(x=>x.id===id);if(!m)return;$("messageId").value=m.id;$("messageName").value=m.name;$("messageType").value=m.type;$("messageBody").value=m.body;$("messageFormTitle").textContent="Editar mensagem";openView("messages");}
function delMessage(id){if(confirm("Excluir mensagem?")){write(K.messages,read(K.messages).filter(m=>m.id!==id));render();}}
function renderMessages(){const q=searchQuery();const rows=read(K.messages).filter(m=>textMatch(`${m.name} ${m.type||""} ${m.body||""}`,q));$("messagesTable").innerHTML=rows.map(m=>`<tr><td><b>${m.name}</b></td><td>${m.type}</td><td>${m.body}</td><td><div class="actionGroup"><button onclick="editMessage('${m.id}')">Editar</button><button class="danger" onclick="delMessage('${m.id}')">Excluir</button></div></td></tr>`).join("") || `<tr><td colspan="4"><small>Nenhuma mensagem encontrada para essa busca.</small></td></tr>`;}

function customerOrders(c){
  return read(K.orders)
    .filter(o=>sameCustomer(c,o))
    .sort((a,b)=>String(b.orderDate||"").localeCompare(String(a.orderDate||"")));
}
function customerLastDate(os){
  return os.map(o=>o.orderDate).filter(Boolean).sort().at(-1)||"-";
}
function renderCustomers(){
  const q=searchQuery();
  const rows=read(K.customers).filter(c=>textMatch(`${c.name} ${c.phone||""} ${c.cep||""} ${c.address||""} ${c.number||""} ${c.district||""} ${c.city||""} ${c.uf||""}`,q));
  $("customersTable").innerHTML=rows.map(c=>{
    const os=customerOrders(c);
    const total=os.reduce((s,o)=>s+revenue(o),0);
    return `<tr>
      <td><b>${esc(c.name)}</b></td>
      <td>${esc(c.phone||"-")}</td>
      <td>${esc(c.address||"-")}, ${esc(c.number||"")}<br><small>${esc(c.district||"")} ${esc(c.city||"")}/${esc(c.uf||"")} CEP ${esc(c.cep||"")}</small></td>
      <td><button class="linkBtn" onclick="openCustomerOrders('${c.id}')">${os.length}</button></td>
      <td>${brl(total)}</td>
      <td>${customerLastDate(os)}</td>
      <td><div class="customerActions"><button onclick="openCustomerEdit('${c.id}')">Editar</button><button onclick="openCustomerOrders('${c.id}')">Ver pedidos</button></div></td>
    </tr>`;
  }).join("") || `<tr><td colspan="7"><small>Nenhum cliente encontrado para essa busca.</small></td></tr>`;
}
function openCustomerOrders(id){
  const c=read(K.customers).find(x=>x.id===id);
  if(!c) return;
  const os=customerOrders(c);
  const total=os.reduce((s,o)=>s+revenue(o),0);
  const frete=os.reduce((s,o)=>s+num(o.saleShipping),0);
  const lucro=os.reduce((s,o)=>s+profit(o),0);
  $("customerOrdersTitle").textContent=`Pedidos de ${c.name||"cliente"}`;
  $("customerOrdersSummary").textContent=`${os.length} pedido(s) • Total comprado ${brl(total)} • Frete ${brl(frete)} • Lucro ${brl(lucro)}`;
  $("customerOrdersTable").innerHTML=os.map(o=>`<tr>
    <td>${esc(o.orderDate||"-")}</td>
    <td>${esc(o.amazonOrderId||"-")}</td>
    <td>${esc(o.productName||"-")}</td>
    <td>${lineQuantity(o)}</td>
    <td>${brl(num(o.salePrice)*lineQuantity(o))}</td>
    <td>${brl(num(o.saleShipping))}</td>
    <td><b>${brl(revenue(o))}</b></td>
    <td class="success">${brl(profit(o))}</td>
    <td><span class="status ${statusClass(o.status)}">${esc(o.status||"-")}</span></td>
  </tr>`).join("") || `<tr><td colspan="9"><small>Nenhum pedido vinculado a este cliente.</small></td></tr>`;
  $("customerOrdersModal").style.display="grid";
}
function closeCustomerOrders(){ if($("customerOrdersModal")) $("customerOrdersModal").style.display="none"; }
function openCustomerEdit(id){
  const c=read(K.customers).find(x=>x.id===id);
  if(!c) return;
  $("editCustomerId").value=c.id;
  $("editCustomerName").value=c.name||"";
  $("editCustomerPhone").value=c.phone||"";
  $("editCustomerCep").value=c.cep||"";
  $("editCustomerAddress").value=c.address||"";
  $("editCustomerNumber").value=c.number||"";
  $("editCustomerComplement").value=c.complement||"";
  $("editCustomerDistrict").value=c.district||"";
  $("editCustomerCity").value=c.city||"";
  $("editCustomerUf").value=c.uf||"";
  $("customerEditModal").style.display="grid";
}
function closeCustomerEdit(){ if($("customerEditModal")) $("customerEditModal").style.display="none"; }
function saveCustomerEdit(e){
  e.preventDefault();
  const id=$("editCustomerId").value;
  const updated={
    id, name:$("editCustomerName").value.trim(), phone:$("editCustomerPhone").value.trim(), cep:$("editCustomerCep").value.trim(),
    address:$("editCustomerAddress").value.trim(), number:$("editCustomerNumber").value.trim(), complement:$("editCustomerComplement").value.trim(),
    district:$("editCustomerDistrict").value.trim(), city:$("editCustomerCity").value.trim(), uf:$("editCustomerUf").value.trim().toUpperCase()
  };
  write(K.customers, read(K.customers).map(c=>c.id===id?{...c,...updated}:c));
  write(K.orders, read(K.orders).map(o=>o.customerId===id?{...o,customerName:updated.name,customerPhone:updated.phone,customerCep:updated.cep,customerAddress:updated.address,customerNumber:updated.number,customerComplement:updated.complement,customerDistrict:updated.district,customerCity:updated.city,customerUf:updated.uf}:o));
  closeCustomerEdit();
  render();
}
function renderFinance(){
  const orders=filteredOrders();
  const rev=orders.reduce((s,o)=>s+revenue(o),0);
  const revProducts=orders.reduce((s,o)=>s+(num(o.salePrice)*lineQuantity(o)),0);
  const revShipping=orders.reduce((s,o)=>s+num(o.saleShipping),0);
  const supplierOut=orders.reduce((s,o)=>s+supplierOrderCost(o),0);
  const amazonOut=orders.reduce((s,o)=>s+num(o.amazonFees),0);
  const out=supplierOut+amazonOut;
  const prof=orders.reduce((s,o)=>s+profit(o),0);
  $("finIn").textContent=brl(rev);$("finOut").textContent=brl(out);$("finProfitKpi").textContent=brl(prof);$("finMarginKpi").textContent=rev?`${margin(prof,rev).toFixed(1)}%`:"0%";$("finOrders").textContent=orders.length;
  if($("finProductRevenue")) $("finProductRevenue").textContent=brl(revProducts);
  if($("finShippingRevenue")) $("finShippingRevenue").textContent=brl(revShipping);
  if($("finSupplierCosts")) $("finSupplierCosts").textContent=brl(supplierOut);
  if($("finAmazonCosts")) $("finAmazonCosts").textContent=brl(amazonOut);
  const monthly=Object.values(groupBy(orders,o=>monthKey(o.orderDate))).map(arr=>({month:monthKey(arr[0].orderDate),orders:arr.length,rev:arr.reduce((s,o)=>s+revenue(o),0),supplier:arr.reduce((s,o)=>s+supplierOrderCost(o),0),amazon:arr.reduce((s,o)=>s+num(o.amazonFees),0),profit:arr.reduce((s,o)=>s+profit(o),0)})).sort((a,b)=>String(b.month).localeCompare(String(a.month)));
  if($("financeMonthlyTable")) $("financeMonthlyTable").innerHTML=monthly.map(m=>`<tr><td><b>${monthLabel(m.month)}</b></td><td>${m.orders}</td><td>${brl(m.rev)}</td><td>${brl(m.supplier)}</td><td>${brl(m.amazon)}</td><td class="success">${brl(m.profit)}</td><td>${m.rev?margin(m.profit,m.rev).toFixed(1):"0.0"}%</td></tr>`).join("") || `<tr><td colspan="7"><small>Sem dados mensais.</small></td></tr>`;
  $("financeTable").innerHTML=orders.map(o=>`<tr><td>${o.orderDate}</td><td>${o.amazonOrderId}</td><td>${o.customerName}</td><td>${brl(num(o.salePrice)*lineQuantity(o))}</td><td>${brl(num(o.saleShipping))}</td><td>${brl(supplierOrderCost(o))}</td><td>${amazonFeeDisplay(o)}</td><td>${brl(revenue(o))}</td><td>${brl(cost(o))}</td><td class="success">${brl(profit(o))}</td><td>${margin(profit(o),revenue(o)).toFixed(1)}%</td></tr>`).join("");
}
function renderReports(){
  $("reportProductsTable").innerHTML=productStats().map((p,i)=>`<tr><td>${i+1}</td><td><b>${p.name}</b></td><td>${p.qty}</td><td>${brl(p.rev)}</td><td class="success">${brl(p.profit)}</td><td>${p.rev?(p.profit/p.rev*100).toFixed(1):0}%</td></tr>`).join("");
  $("reportSuppliersTable").innerHTML=supplierStats().map((s,i)=>`<tr><td>${i+1}</td><td><b>${s.name}</b></td><td>${s.qty}</td><td>${brl(s.rev)}</td><td class="success">${brl(s.profit)}</td></tr>`).join("");
}
function renderAnalytics(){
  const ps=productStats(), ss=supplierStats(), orders=read(K.orders);
  const customerMap=Object.values(groupBy(orders,o=>o.customerName)).map(a=>({name:a[0].customerName,qty:a.length})).sort((a,b)=>b.qty-a.qty);
  $("bestProduct").textContent=ps[0]?.name||"-";$("bestSupplier").textContent=ss[0]?.name||"-";$("bestCustomer").textContent=customerMap[0]?.name||"-";
  $("bestMargin").textContent=ps[0]?.rev?`${(ps[0].profit/ps[0].rev*100).toFixed(1)}%`:"-";
  const pending=orders.filter(o=>!o.trackingCode && !["Cancelado","Entregue","Reembolsado"].includes(o.status)).length;
  $("alertsList").innerHTML=`<div class="alertItem"><b>Pedidos sem rastreio</b><span>${pending} pedido(s) ainda estão sem código de rastreio.</span></div><div class="alertItem"><b>Produtos ativos</b><span>${read(K.products).filter(p=>p.status==="Ativo na Amazon").length} produto(s) ativos no catálogo.</span></div>`;
}

function buildAiPrompt(){return `Analise o print de pedido/venda Amazon e retorne SOMENTE JSON válido, sem markdown, no formato:
{
 "orderDate":"YYYY-MM-DD",
 "amazonOrderId":"",
 "productName":"",
 "asin":"",
 "sku":"",
 "customerName":"",
 "customerPhone":"",
 "customerCep":"",
 "customerAddress":"",
 "customerNumber":"",
 "customerComplement":"",
 "customerDistrict":"",
 "customerCity":"",
 "customerUf":"",
 "salePrice":0,
 "saleShipping":0,
 "status":"Venda realizada Amazon",
 "trackingCode":"",
 "trackingSent":"Não",
 "notes":"",
 "confidence":{"orderDate":"alta/média/baixa","amazonOrderId":"alta/média/baixa","productName":"alta/média/baixa","customerName":"alta/média/baixa","address":"alta/média/baixa","values":"alta/média/baixa"}
}
Regra crítica para data: preencha orderDate usando exclusivamente o campo "Data da compra" do pedido Amazon. Não use prazo para envio, prazo de entrega, data de entrega, data atual ou data de registro.
Regra V11.5: o print de pedido normalmente NÃO mostra o custo Amazon/taxa por indicação. Não invente essa taxa. Ela será preenchida manualmente depois no Prime Control, se necessário.
Não invente dados. Se não encontrar, deixe vazio ou 0.`;}

function firstDefined(...vals){
  for(const v of vals){ if(v!==undefined && v!==null && String(v).trim()!=="") return v; }
  return "";
}
function parseDateBrOrIso(v){
  const raw=String(v||"").trim();
  if(!raw) return "";
  if(/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0,10);
  const m=raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if(m){
    const dd=m[1].padStart(2,"0"), mm=m[2].padStart(2,"0");
    const yyyy=m[3].length===2?`20${m[3]}`:m[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  const months={jan:"01",fev:"02",mar:"03",abr:"04",mai:"05",jun:"06",jul:"07",ago:"08",set:"09",out:"10",nov:"11",dez:"12"};
  const lower=raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  const m2=lower.match(/(\d{1,2}).*?de\s+([a-z]{3}).*?de\s+(\d{4})/);
  if(m2 && months[m2[2]]) return `${m2[3]}-${months[m2[2]]}-${m2[1].padStart(2,"0")}`;
  return raw;
}
function splitAddress(raw, customerName=""){
  const out={customerAddress:"",customerNumber:"",customerComplement:"",customerDistrict:"",customerCity:"",customerUf:"",customerCep:""};
  const original=String(raw||"").trim();
  if(!original) return out;

  // Mantém quebras de linha quando existirem. Isso permite separar:
  // Rua/número | complemento/bairro | cidade/UF/CEP
  const customerKey=cleanKey(customerName);
  const lines=original
    .split(/\r?\n|\s{2,}|\|/)
    .map(x=>x.replace(/\s+/g," ").trim())
    .filter(Boolean)
    .filter(x=>!customerKey || cleanKey(x)!==customerKey);
  const text=lines.join(" ");

  const cep=text.match(/(\d{5})[-\s]?(\d{3})\b/);
  if(cep) out.customerCep=cep[1]+cep[2];

  const cityLine=lines.find(l=>/,\s*[A-Z]{2}(?:\s|$)/.test(l)) || text;
  const cityUf=cityLine.match(/([A-Za-zÀ-ÿ0-9\s'.-]+?),\s*([A-Z]{2})(?:\s|$)/);
  if(cityUf){
    out.customerCity=cityUf[1].trim();
    out.customerUf=cityUf[2].trim().toUpperCase();
  }

  // Se o endereço veio só como "Cidade, UF CEP", não inventa rua.
  const onlyCityCep = out.customerCity && lines.length===1 && text.replace(out.customerCity,"").match(/^,?\s*[A-Z]{2}\s*\d{5}[-\s]?\d{3}\s*$/i);
  if(onlyCityCep) return out;

  // Usa a primeira linha que não seja a linha de cidade/UF/CEP como rua/número.
  const cityLineIndex=lines.findIndex(l=>/,\s*[A-Z]{2}(?:\s|$)/.test(l));
  const addressLines=lines.filter((_,i)=>i!==cityLineIndex);
  const first=addressLines[0]||"";
  const m=first.match(/^(.+?)\s+(\d+[A-Za-z]?)\b\s*(.*)$/);
  if(m){
    out.customerAddress=m[1].trim();
    out.customerNumber=m[2].trim();
    const rest=m[3].trim();
    const extra=addressLines.slice(1).join(" ").trim();
    out.customerComplement=[rest, extra].filter(Boolean).join(" ");
  }else{
    out.customerAddress=first;
    out.customerComplement=addressLines.slice(1).join(" ").trim();
  }

  return out;
}

function normalizeImportData(d){
  d=d||{};
  const customer=d.customer||{};
  const addr=d.shippingAddress||d.address||{};
  const product=d.product||{};
  const sale=d.sale||{};
  const costs=d.costs||{};
  const supplier=d.supplier||{};
  const rawAddr=firstDefined(d.customerAddress,d.endereco,d.enderecoEntrega,d["Endereço de entrega"],addr.full,addr.raw);
  const parsed=splitAddress(rawAddr);
  const salePrice=moneyNum(firstDefined(d.salePrice,d.productPrice,d.precoVenda,d.preco_venda,sale.productPrice,sale.salePrice,product.unitPrice));
  const saleShipping=moneyNum(firstDefined(d.saleShipping,d.shipping,d.frete,sale.shippingCharged,sale.shipping));
  const totalRevenue=moneyNum(firstDefined(d.totalRevenue,d.total,sale.totalRevenue));
  const finalSaleShipping=saleShipping || (totalRevenue && salePrice ? totalRevenue-salePrice : 0);
  return {
    orderDate: parseDateBrOrIso(firstDefined(d.orderDate,d.purchaseDate,d.dataVenda,d.data_da_venda,d.data_compra)),
    purchaseTime:firstDefined(d.purchaseTime,d.horaCompra),
    amazonOrderId:firstDefined(d.amazonOrderId,d.orderId,d.idVenda,d.id_venda,d.pedido,d.venda),
    productName:firstDefined(d.productName,d.produto,product.name,product.title),
    asin:firstDefined(d.asin,product.asin),
    sku:firstDefined(d.sku,product.sku),
    customerName:firstDefined(d.customerName,d.cliente,customer.name),
    customerPhone:firstDefined(d.customerPhone,d.telefone,d.phone,customer.phone),
    customerCpf:firstDefined(d.customerCpf,d.cpf,customer.cpf),
    customerCep:firstDefined(d.customerCep,d.cep,addr.zipCode,addr.cep,parsed.customerCep),
    customerAddress:firstDefined(d.customerAddress,addr.street,addr.address,parsed.customerAddress),
    customerNumber:firstDefined(d.customerNumber,addr.number,parsed.customerNumber),
    customerComplement:firstDefined(d.customerComplement,addr.complement,parsed.customerComplement),
    customerDistrict:firstDefined(d.customerDistrict,addr.district,parsed.customerDistrict),
    customerCity:firstDefined(d.customerCity,addr.city,parsed.customerCity),
    customerUf:firstDefined(d.customerUf,addr.state,addr.uf,parsed.customerUf),
    salePrice:salePrice || (totalRevenue && !finalSaleShipping ? totalRevenue : 0),
    saleShipping:finalSaleShipping,
    quantity: Number(firstDefined(d.quantity,d.quantidade,product.quantity,sale.quantity,1))||1,
    supplierName:firstDefined(d.supplierName,d.fornecedor,d.fornecedorComprado,d.fornecedor_comprado,supplier.name),
    supplierId:firstDefined(d.supplierId,supplier.id),
    buyLink:firstDefined(d.buyLink,d.linkCompra,d.link_compra,d.linkDoProduto,d.link_do_produto,supplier.purchaseLink),
    buyPrice:moneyNum(firstDefined(d.buyPrice,d.supplierCost,d.precoFornecedor,d.preco_fornecedor,costs.supplierCost,costs.buyPrice)),
    buyShipping:moneyNum(firstDefined(d.buyShipping,d.supplierShipping,d.freteFornecedor,d.frete_do_fornecedor,costs.supplierShipping)),
    buyDiscount:moneyNum(firstDefined(d.buyDiscount,d.supplierDiscount,d.desconto,costs.supplierDiscount)),
    amazonFees:moneyNum(firstDefined(d.amazonFees,d.amazonCost,d.custoAmazon,d.custo_amazon,costs.amazonFee,costs.amazonCost)),
    status:firstDefined(d.status,"Venda realizada Amazon"),
    trackingCode:firstDefined(d.trackingCode,d.rastreio),
    trackingSent:firstDefined(d.trackingSent,"Não"),
    notes:firstDefined(d.notes,d.observacoes,"Importado por JSON/Excel. Confira campos pendentes."),
    messageTemplateId:firstDefined(d.messageTemplateId,"")
  };
}
function ensureSupplierByName(name){
  const clean=String(name||"").trim();
  if(!clean) return "";
  let arr=read(K.suppliers);
  let s=arr.find(x=>String(x.name||"").toLowerCase()===clean.toLowerCase());
  if(s) return s.id;
  s={id:uuid(),name:clean,type:"Importado",whatsapp:"",site:"",leadTime:"",status:"Ativo",notes:"Criado automaticamente pela importação V11.5."};
  arr.push(s);write(K.suppliers,arr);return s.id;
}
function fillAiFromImport(raw){
  const d=normalizeImportData(raw);
  fillAi(d);
  if(d.supplierName && !d.supplierId){
    const sid=ensureSupplierByName(d.supplierName);
    renderSelects();
    if($("aiSupplierId")) $("aiSupplierId").value=sid;
  }
  if($("aiBuyLink")) $("aiBuyLink").value=d.buyLink||"";
  if($("aiBuyPrice")) $("aiBuyPrice").value=d.buyPrice||0;
  if($("aiBuyShipping")) $("aiBuyShipping").value=d.buyShipping||0;
  if($("aiBuyDiscount")) $("aiBuyDiscount").value=d.buyDiscount||0;
  if($("aiAmazonFees")) $("aiAmazonFees").value=d.amazonFees||0;
  updateAiCalc();
}


function extractJsonPayload(text){
  let raw=String(text||'').trim();
  if(!raw) throw new Error('JSON vazio');
  // Aceita quando o usuário cola com markdown: ```json ... ```
  const fence=raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fence) raw=fence[1].trim();
  // Aceita textos antes/depois: extrai do primeiro {/[ até o último }/]
  const firstObj=raw.indexOf('{'), firstArr=raw.indexOf('[');
  let start=-1, end=-1;
  if(firstObj>=0 && (firstArr<0 || firstObj<firstArr)){ start=firstObj; end=raw.lastIndexOf('}'); }
  else if(firstArr>=0){ start=firstArr; end=raw.lastIndexOf(']'); }
  if(start>=0 && end>start) raw=raw.slice(start,end+1).trim();
  return JSON.parse(raw);
}
function updateAiCalc(){
  const revenue=num($("aiSalePrice")?.value)+num($("aiSaleShipping")?.value);
  const supplier=num($("aiBuyPrice")?.value)+num($("aiBuyShipping")?.value)-num($("aiBuyDiscount")?.value);
  const amazon=num($("aiAmazonFees")?.value);
  const profit=revenue-supplier-amazon;
  if($("aiRevenueCalc")) $("aiRevenueCalc").textContent=brl(revenue);
  if($("aiSupplierCalc")) $("aiSupplierCalc").textContent=brl(supplier);
  if($("aiAmazonCalc")) $("aiAmazonCalc").textContent=brl(amazon);
  if($("aiProfitCalc")) $("aiProfitCalc").textContent=brl(profit);
}

// V11.8 - Handler robusto para Analisar JSON
// Corrigido para executar apenas uma vez por clique, evitando popup duplicado.
window.__npcJsonAnalyzing = false;
window.npcAnalyzeJson = function(event){
  if(event && event.preventDefault) event.preventDefault();
  if(event && event.stopPropagation) event.stopPropagation();
  if(event && event.stopImmediatePropagation) event.stopImmediatePropagation();
  if(window.__npcJsonAnalyzing) return false;
  window.__npcJsonAnalyzing = true;
  setTimeout(()=>{ window.__npcJsonAnalyzing = false; }, 500);
  try{
    const input = $("aiJsonInput");
    if(!input){ alert("Campo de JSON não encontrado. Atualize a página e tente novamente."); return false; }
    const text = String(input.value || "").trim();
    if(!text){ alert("Cole um JSON antes de analisar."); input.focus(); return false; }
    let parsed = extractJsonPayload(text);
    if(Array.isArray(parsed)){
      if(!parsed.length){ alert("O JSON está vazio. Informe pelo menos um pedido."); return false; }
      parsed = parsed[0];
      alert("Detectei uma lista de pedidos. Para esta análise, carreguei o primeiro registro. Para importar vários, use Excel/CSV ou backup JSON.");
    }
    if(typeof fillAiFromImport !== "function"){
      alert("O analisador interno não foi carregado. Atualize a página e tente novamente.");
      return false;
    }
    fillAiFromImport(parsed);
    if($("aiReviewPanel")) $("aiReviewPanel").style.display="block";
    if($("aiReviewPanel")) $("aiReviewPanel").scrollIntoView({behavior:"smooth", block:"start"});
    alert("JSON analisado. Revise os campos antes de salvar.");
    return false;
  }catch(e){
    console.error("Erro ao analisar JSON", e);
    alert("Não consegui importar este JSON. Detalhe técnico: "+(e&&e.message?e.message:e)+"\n\nAgora a V12.1 aceita JSON simples, JSON completo/nested e até bloco com ```json. Se continuar, confira se campos como productName/customerName existem ou ficaram vazios.");
    return false;
  }
};

// V12.1 - Limpar IA/importação de forma direta e segura
window.npcClearAi = function(event){
  if(event && event.preventDefault) event.preventDefault();
  if(event && event.stopPropagation) event.stopPropagation();
  if(event && event.stopImmediatePropagation) event.stopImmediatePropagation();
  try{
    const input=$("aiJsonInput"); if(input) input.value="";
    if(typeof clearPrintImage === "function") clearPrintImage();
    const panel=$("aiReviewPanel"); if(panel) panel.style.display="none";
    const status=$("aiStatusText"); if(status) status.textContent="Campos limpos. Cole um novo JSON ou escolha outra forma de importação.";
    return false;
  }catch(e){
    console.error("Erro ao limpar importação", e);
    alert("Não consegui limpar a tela. Atualize a página e tente novamente.");
    return false;
  }
};

function setupAi(){
  if($("aiPrompt")) $("aiPrompt").value=buildAiPrompt();
  const drop=$("printDrop"), fileInput=$("printFile"), selectBtn=$("selectPrintBtn"), pasteBtn=$("pastePrintBtn"), removeBtn=$("removePrintBtn"), focusBtn=$("focusPasteBtn");
  const status=(msg)=>{ if($("aiStatusText")) $("aiStatusText").textContent=msg||""; };
  const handleFile=(file)=>{
    if(!file) return;
    previewPrint(file);
    status("Imagem carregada com sucesso. Confira a prévia abaixo.");
  };

  window.npcHandlePrintFile = handleFile;
  window.npcOpenPrintPicker = ()=>{
    const input=$("printFile");
    if(!input) return alert("Campo de imagem não encontrado. Atualize a página e tente novamente.");
    input.value="";
    input.click();
  };
  window.npcFocusPasteArea = ()=>{
    const zone=$("printDrop");
    if(zone){ zone.focus(); status("Área ativada. Agora use CTRL+V para colar o print copiado."); }
  };
  window.npcHandlePaste = (e)=>{
    const items=[...(e.clipboardData?.items||[])];
    const item=items.find(i=>i.type&&i.type.startsWith("image/"));
    if(!item) return false;
    e.preventDefault();
    const file=item.getAsFile();
    if(file) handleFile(file);
    return true;
  };

  if($("copyPromptBtn")) $("copyPromptBtn").onclick=async()=>{await navigator.clipboard.writeText($("aiPrompt").value);alert("Prompt copiado. Cole no ChatGPT junto com o print.");};

  if(fileInput){
    fileInput.onchange=e=>{
      const file=e.target.files && e.target.files[0];
      if(file) handleFile(file);
      else status("Nenhuma imagem selecionada.");
    };
  }

  if(selectBtn) selectBtn.onclick=window.npcOpenPrintPicker;
  if(focusBtn) focusBtn.onclick=window.npcFocusPasteArea;
  if(drop){
    drop.onclick=()=>{ drop.focus(); status("Área ativada. Use CTRL+V para colar, ou arraste a imagem aqui."); };
    drop.onkeydown=e=>{ if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="v") status("Recebendo imagem da área de transferência..."); };
    drop.addEventListener("paste",window.npcHandlePaste);
    drop.addEventListener("focus",()=>drop.classList.add("readyPaste"));
    drop.addEventListener("blur",()=>drop.classList.remove("readyPaste"));
    drop.addEventListener("dragover",e=>{e.preventDefault();drop.classList.add("dragging");});
    drop.addEventListener("dragleave",()=>drop.classList.remove("dragging"));
    drop.addEventListener("drop",e=>{
      e.preventDefault();
      drop.classList.remove("dragging");
      const file=e.dataTransfer?.files && e.dataTransfer.files[0];
      if(file) handleFile(file);
      else status("Não encontrei arquivo no arraste. Tente selecionar a imagem pelo botão.");
    });
  }

  const pasteFromClipboard=async()=>{
    try{
      if(!navigator.clipboard?.read) throw new Error("Clipboard API indisponível");
      const clipboardItems=await navigator.clipboard.read();
      for(const clipboardItem of clipboardItems){
        const imageType=clipboardItem.types.find(t=>t.startsWith("image/"));
        if(imageType){
          const blob=await clipboardItem.getType(imageType);
          const ext=(imageType.split("/")[1]||"png").replace("jpeg","jpg");
          const file=new File([blob],`print-colado.${ext}`,{type:imageType});
          handleFile(file);
          return;
        }
      }
      alert("Não encontrei imagem na área de transferência. Use Win + Shift + S, copie o print e tente novamente, ou selecione o arquivo.");
    }catch(err){
      window.npcFocusPasteArea();
      alert("Seu navegador bloqueou o botão de colar direto. A área foi ativada: use CTRL+V nela ou use Selecionar imagem.");
    }
  };
  if(pasteBtn) pasteBtn.onclick=pasteFromClipboard;

  // Fallback forte: mesmo que algum onclick acima falhe, estes eventos por delegação continuam funcionando.
  document.addEventListener("click",e=>{
    const id=e.target?.id;
    if(id==="selectPrintBtn") { e.preventDefault(); window.npcOpenPrintPicker(); }
    if(id==="focusPasteBtn") { e.preventDefault(); window.npcFocusPasteArea(); }
    if(id==="pastePrintBtn") { e.preventDefault(); pasteFromClipboard(); }
    if(id==="removePrintBtn") { e.preventDefault(); clearPrintImage(); }
  });
  document.addEventListener("paste",e=>{
    const activeView=document.querySelector(".view.active");
    if(activeView?.id==="aiImport") window.npcHandlePaste(e);
  });

  if(removeBtn) removeBtn.onclick=clearPrintImage;

  // V12.1: remove qualquer handler antigo e registra UM handler direto nos botões de JSON.
  const bindCleanClick=(id,fn)=>{
    const el=$(id);
    if(!el) return;
    const clone=el.cloneNode(true);
    el.parentNode.replaceChild(clone,el);
    clone.onclick=fn;
  };
  bindCleanClick("analyzeJsonBtn", window.npcAnalyzeJson);
  bindCleanClick("clearAiBtn", window.npcClearAi);
  if($("autoAnalyzeBtn")) $("autoAnalyzeBtn").onclick=analyzePrintBackend;
  if($("sendAiToOrderBtn")) $("sendAiToOrderBtn").onclick=sendAiToOrder;
  ["aiSalePrice","aiSaleShipping","aiBuyPrice","aiBuyShipping","aiBuyDiscount","aiAmazonFees"].forEach(id=>{ if($(id)) $(id).addEventListener("input",updateAiCalc); });
  if($("aiReviewForm")) $("aiReviewForm").onsubmit=e=>{e.preventDefault();saveAiOrder();};
}
function previewPrint(file){
  if(!file||!file.type?.startsWith("image/")){alert("Selecione uma imagem válida: PNG, JPG, JPEG ou WEBP.");return;}
  const r=new FileReader();
  r.onload=e=>{
    selectedPrintDataUrl=e.target.result;
    $("printPreview").src=e.target.result;
    $("printPreview").style.display="block";
    $("printDrop").classList.add("hasImage");
    if($("printLoadedInfo")){
      $("printLoadedInfo").style.display="block";
      $("printLoadedInfo").textContent=`Imagem carregada: ${file.name||"print colado da área de transferência"}`;
    }
    if($("removePrintBtn")) $("removePrintBtn").style.display="inline-flex";
    if($("aiStatusText")) $("aiStatusText").textContent="Imagem carregada. Agora você pode analisar automaticamente ou usar o prompt manual.";
  };
  r.readAsDataURL(file);
}
function clearPrintImage(){
  selectedPrintDataUrl="";
  if($("printDrop")){ $("printDrop").classList.remove("hasImage"); }
  if($("printPreview")){ $("printPreview").src=""; $("printPreview").style.display="none"; }
  if($("printFile")) $("printFile").value="";
  if($("printDrop")) $("printDrop").classList.remove("hasImage","dragging");
  if($("printLoadedInfo")){ $("printLoadedInfo").style.display="none"; $("printLoadedInfo").textContent=""; }
  if($("removePrintBtn")) $("removePrintBtn").style.display="none";
  if($("aiStatusText")) $("aiStatusText").textContent="";
}
function analyzePrintBackend(){
  const msg="Integração IA/OCR não configurada. Para importar agora, use JSON, CSV ou cadastro manual. A análise automática por imagem só será ativada quando houver uma integração real configurada.";
  if($("aiStatusText")) $("aiStatusText").textContent=msg;
  alert(msg);
  if($("aiJsonInput")) $("aiJsonInput").focus();
}
function fillAi(d){
  d=normalizeImportData(d);
  $("aiReviewPanel").style.display="block";
  renderSelects();
  const baseNotes=d.notes||"";
  const pending=[];
  if(!d.amazonFees) pending.push("Custo Amazon pendente");
  if(!d.buyPrice) pending.push("Custo fornecedor pendente");
  if(!d.buyLink) pending.push("Link de compra pendente");
  const pendingNote=pending.length?`Pendências: ${pending.join(", ")}.`:"";
  const notes=[baseNotes,pendingNote].filter(Boolean).join(" ");
  const map={aiOrderDate:d.orderDate||"",aiAmazonOrderId:d.amazonOrderId,aiProductName:d.productName,aiAsin:d.asin,aiSku:d.sku,aiCustomerName:d.customerName,aiCustomerPhone:d.customerPhone,aiCustomerCep:d.customerCep,aiCustomerAddress:d.customerAddress,aiCustomerNumber:d.customerNumber,aiCustomerComplement:d.customerComplement,aiCustomerDistrict:d.customerDistrict,aiCustomerCity:d.customerCity,aiCustomerUf:d.customerUf,aiSalePrice:d.salePrice,aiSaleShipping:d.saleShipping,aiStatus:d.status||"Venda realizada Amazon",aiTrackingCode:d.trackingCode,aiTrackingSent:d.trackingSent||"Não",aiNotes:notes,aiBuyLink:d.buyLink,aiBuyPrice:d.buyPrice||0,aiBuyShipping:d.buyShipping||0,aiBuyDiscount:d.buyDiscount||0,aiAmazonFees:d.amazonFees||0};
  Object.entries(map).forEach(([k,v])=>{if($(k))$(k).value=v??""});
  if(d.supplierId && $("aiSupplierId")) $("aiSupplierId").value=d.supplierId;
  else if(d.supplierName && $("aiSupplierId")) $("aiSupplierId").value=ensureSupplierByName(d.supplierName);
  updateAiCalc();
}
function aiData(){return{orderDate:$("aiOrderDate").value,amazonOrderId:$("aiAmazonOrderId").value,productName:$("aiProductName").value,asin:$("aiAsin").value,sku:$("aiSku").value,customerName:$("aiCustomerName").value,customerPhone:$("aiCustomerPhone").value,customerCep:$("aiCustomerCep").value,customerAddress:$("aiCustomerAddress").value,customerNumber:$("aiCustomerNumber").value,customerComplement:$("aiCustomerComplement").value,customerDistrict:$("aiCustomerDistrict").value,customerCity:$("aiCustomerCity").value,customerUf:$("aiCustomerUf").value,salePrice:num($("aiSalePrice").value),saleShipping:num($("aiSaleShipping").value),supplierId:$("aiSupplierId").value,buyLink:$("aiBuyLink").value,buyPrice:num($("aiBuyPrice").value),buyShipping:num($("aiBuyShipping").value),buyDiscount:num($("aiBuyDiscount").value),amazonFees:num($("aiAmazonFees").value),status:$("aiStatus").value,trackingCode:$("aiTrackingCode").value,trackingSent:$("aiTrackingSent").value,messageTemplateId:$("aiMessageTemplateId").value,notes:$("aiNotes").value};}
function findOrCreateProduct(d){let arr=read(K.products);let p=arr.find(x=>x.asin&&d.asin&&x.asin===d.asin)||arr.find(x=>sameProductName(x.name,d.productName)); if(p)return p; p={id:uuid(),name:d.productName||"Produto importado",category:"Importado",asin:d.asin||"",sku:d.sku||"",supplierId:d.supplierId,buyLink:d.buyLink,status:"Ativo na Amazon",buyPrice:d.buyPrice,buyShipping:d.buyShipping,salePrice:d.salePrice,saleShipping:d.saleShipping,amazonFees:d.amazonFees,notes:"Criado via importação V11.5."};arr.push(p);write(K.products,arr);return p;}
function saveAiOrder(){const d=aiData();if(!d.productName||!d.customerName)return alert("Produto e cliente são obrigatórios.");const p=findOrCreateProduct(d);let o={id:uuid(),orderDate:d.orderDate||today(),amazonOrderId:d.amazonOrderId,productId:p.id,productName:p.name,customerName:d.customerName,customerPhone:d.customerPhone,customerCep:d.customerCep,customerAddress:d.customerAddress,customerNumber:d.customerNumber,customerComplement:d.customerComplement,customerDistrict:d.customerDistrict,customerCity:d.customerCity,customerUf:d.customerUf,supplierId:d.supplierId,buyLink:d.buyLink,status:d.status||"Venda realizada Amazon",salePrice:d.salePrice,saleShipping:d.saleShipping,buyPrice:d.buyPrice,buyShipping:d.buyShipping,buyDiscount:d.buyDiscount,amazonFees:d.amazonFees,trackingCode:d.trackingCode,trackingSent:d.trackingSent,messageTemplateId:d.messageTemplateId,notes:d.notes,createdAt:new Date().toISOString()};let orders=read(K.orders);if(!confirmIfDuplicate(o,orders,o.id)) return;o.customerId=upsertCustomer(o);orders.push(o);write(K.orders,orders);logAiImport(d,o.id,p.id);render();alert("Pedido importado com sucesso.");openView("dashboard");}
function sendAiToOrder(){const d=aiData();const p=findOrCreateProduct(d);render();$("orderProductId").value=p.id;$("orderDate").value=d.orderDate||"";$("amazonOrderId").value=d.amazonOrderId;$("customerName").value=d.customerName;$("customerPhone").value=d.customerPhone;$("customerCep").value=d.customerCep;$("customerAddress").value=d.customerAddress;$("customerNumber").value=d.customerNumber;$("customerComplement").value=d.customerComplement;$("customerDistrict").value=d.customerDistrict;$("customerCity").value=d.customerCity;$("customerUf").value=d.customerUf;$("orderSupplierId").value=d.supplierId;$("buyLink").value=d.buyLink;$("orderStatus").value=d.status||"Venda realizada Amazon";$("salePrice").value=d.salePrice;$("saleShipping").value=d.saleShipping;$("buyPrice").value=d.buyPrice;$("buyShipping").value=d.buyShipping;$("buyDiscount").value=d.buyDiscount;$("amazonFees").value=d.amazonFees;$("trackingCode").value=d.trackingCode;$("trackingSent").value=d.trackingSent;$("messageTemplateId").value=d.messageTemplateId;$("orderNotes").value=d.notes;openView("orders");}

$("globalSearch").oninput=()=>{orderPage=1;if(activeView()!=="products") lastProductAutoFillQuery="";render();};
$("globalSearch").onkeydown=e=>{if(e.key==="Escape"){$("globalSearch").value="";orderPage=1;render();}};
$("globalPeriod").onchange=()=>{orderPage=1;render();};$("ordersStatusFilter").onchange=()=>{orderPage=1;renderOrdersTable();};$("ordersPageSize").onchange=()=>{orderPage=1;renderOrdersTable();};$("productStatusFilter").onchange=renderProducts;

let csvRowsToImport=[];

function detectCsvDelimiter(text){
  const first=(String(text||"").replace(/^\ufeff/,"").split(/\r?\n/).find(l=>l.trim())||"");
  const count=(sep)=>{
    let c=0, inQuotes=false;
    for(let i=0;i<first.length;i++){
      const ch=first[i], next=first[i+1];
      if(ch==='"' && inQuotes && next==='"'){ i++; continue; }
      if(ch==='"'){ inQuotes=!inQuotes; continue; }
      if(ch===sep && !inQuotes) c++;
    }
    return c;
  };
  const candidates=[";","\t",","];
  return candidates.map(d=>[d,count(d)]).sort((a,b)=>b[1]-a[1])[0][0] || ";";
}
function parseCSVText(text, forcedDelimiter){
  text=String(text||"").replace(/^\ufeff/,"");
  const delimiter=forcedDelimiter || detectCsvDelimiter(text);
  const rows=[]; let row=[], cell="", inQuotes=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i], next=text[i+1];
    if(ch==='"' && inQuotes && next==='"'){cell+='"'; i++; continue;}
    if(ch==='"'){inQuotes=!inQuotes; continue;}
    if(ch===delimiter && !inQuotes){row.push(cell.trim()); cell=""; continue;}
    if((ch==="\n" || ch==="\r") && !inQuotes){
      if(ch==="\r" && next==="\n") i++;
      row.push(cell.trim()); cell="";
      if(row.some(x=>x!=="")) rows.push(row);
      row=[];
      continue;
    }
    cell+=ch;
  }
  row.push(cell.trim());
  if(row.some(x=>x!=="")) rows.push(row);
  return rows;
}
function uniqueHeaders(headers){
  const seen={};
  return headers.map(h=>{
    let base=normalizeHeader(h);
    if(!base || base.startsWith("unnamed")) base="";
    if(!base) return "";
    const count=seen[base]||0;
    seen[base]=count+1;
    return count ? `${base}_${count}` : base;
  });
}
function normalizeHeader(h){return String(h||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"");}
function rowValue(obj,names){for(const n of names){if(obj[n]!==undefined && obj[n]!==null && obj[n]!="") return obj[n];} return "";}
function moneyNum(v){
  let s=String(v??"").trim();
  if(!s || /^[-–—]$/.test(s) || /^R\$\s*[-–—]$/.test(s)) return 0;
  const neg=/^-/.test(s) || /-\s*R\$/.test(s);
  s=s.replace(/R\$/gi,"").replace(/[^0-9,.-]/g,"").replace(/^-/,"")
  if(s.includes(",")){ s=s.replace(/\./g,"").replace(",","."); }
  const n=Number(s);
  return Number.isFinite(n) ? (neg?-Math.abs(n):n) : 0;
}
function isBlankRecord(obj){
  return !Object.values(obj||{}).some(v=>String(v??"").trim()!=="");
}
function mapCsvRecord(obj){
  const defaultSupplierId=$("csvDefaultSupplier")?.value||"";
  const supplierName=rowValue(obj,["fronecedor_comprado","fronecedor","fornecedor_comprado","fornecedor","supplier","nome_fornecedor"]);
  const supplierId=supplierName?ensureSupplierByName(supplierName):defaultSupplierId;
  const salePrice=moneyNum(rowValue(obj,["preco_venda","preco_produto","valor_produto","preco_unitario","valor"]));
  const saleShipping=moneyNum(rowValue(obj,["frete_venda","total_envio","frete","envio"]));
  const totalRevenue=moneyNum(rowValue(obj,["total","receita_total","total_venda","total_produtos"]));
  const buyPrice=moneyNum(rowValue(obj,["preco_fornecedor","preco_compra","custo_fornecedor","supplier_cost"]));
  const buyShipping=moneyNum(rowValue(obj,["frete_do_fornecedor","frete_fornecedor","frete_compra","supplier_shipping"]));
  const buyDiscount=moneyNum(rowValue(obj,["desconto","desconto_compra","supplier_discount"]));
  const totalSupplier=moneyNum(rowValue(obj,["total_fornecedor","total_compra","supplier_total"]));
  const amazonFees=moneyNum(rowValue(obj,["custo_amazon","amazon","amazon_fee","amazon_fees","taxa_amazon"]));
  const addressRaw=rowValue(obj,["endereco_de_entrega","endereco_entrega","endereco","address"]);
  const customerName=rowValue(obj,["cliente","nome_cliente","customer_name","comprador"]);
  const addr=splitAddress(addressRaw, customerName);
  const qty=moneyNum(rowValue(obj,["quantidade","qtd","quantity"])) || 1;
  const supplierQty=moneyNum(rowValue(obj,["quantidade_1","qtd_fornecedor","supplier_quantity"])) || qty;
  const buyLink=rowValue(obj,["link_do_produto","link_produto","link_da_compra","link_compra","purchase_link"]);
  const calcSupplierTotal = totalSupplier || Math.max(0, (buyPrice * supplierQty) + buyShipping - buyDiscount);
  const netProfitRaw=rowValue(obj,["lucro","lucro_liquido","profit","net_profit"]);
  const hasNetProfit=String(netProfitRaw??"").trim()!=="";
  const netProfit=hasNetProfit ? moneyNum(netProfitRaw) : 0;
  const notes=[];
  if(!amazonFees) notes.push("Custo Amazon pendente");
  if(!calcSupplierTotal) notes.push("Custo fornecedor pendente");
  if(!buyLink) notes.push("Link de compra pendente");
  if(!addr.customerAddress && addr.customerCity) notes.push("Endereço parcial: importado apenas cidade/UF/CEP");
  return {
    orderDate: parseDateBrOrIso(rowValue(obj,["data_da_venda","data_venda","data_compra","data","order_date"])),
    amazonOrderId: rowValue(obj,["id_venda","id","venda","pedido","id_pedido","numero_pedido","amazon_order_id","order_id"]),
    productName: rowValue(obj,["produto","nome_produto","product_name","titulo"]),
    asin: rowValue(obj,["asin"]),
    sku: rowValue(obj,["sku"]),
    customerName,
    customerPhone: rowValue(obj,["telefone","phone","whatsapp","telefonedata_da_venda"]),
    customerCep: rowValue(obj,["cep","zipcode","postal_code"]) || addr.customerCep,
    customerAddress: rowValue(obj,["rua","logradouro"]) || addr.customerAddress,
    customerNumber: rowValue(obj,["numero","number"]) || addr.customerNumber,
    customerComplement: rowValue(obj,["complemento","complement"]) || addr.customerComplement,
    customerDistrict: rowValue(obj,["bairro","district"]) || addr.customerDistrict,
    customerCity: rowValue(obj,["cidade","city"]) || addr.customerCity,
    customerUf: rowValue(obj,["uf","estado","state"]) || addr.customerUf,
    salePrice, saleShipping, quantity:qty, totalRevenue,
    status: rowValue(obj,["status"]) || ($("csvDefaultStatus")?.value||"Venda realizada Amazon"),
    supplierId, supplierName,
    buyLink,
    buyPrice,
    buyShipping,
    buyDiscount,
    totalSupplier: calcSupplierTotal,
    supplierQuantity: supplierQty,
    amazonFees,
    netProfit,
    hasNetProfit,
    trackingCode: rowValue(obj,["rastreio","codigo_rastreio","tracking"]),
    trackingSent:"Não",
    notes:["Importado por Excel/CSV V13.2.", ...notes].join(" ")
  };
}
function uniqueCsvRecords(rows){
  const seen=new Set(), out=[];
  rows.forEach(r=>{
    if(!r || isBlankRecord(r)) return;
    const orderKey=normalizeOrderId(r.amazonOrderId);
    // V13.2: o mesmo pedido pode ter mais de um item/produto. A chave passa a ser pedido + produto.
    const key=orderKey ? `${orderKey}|${normalizeProductName(r.productName)}|${num(r.totalRevenue)||num(r.salePrice)}|${num(r.quantity)||1}` : `${normalizeProductName(r.productName)}|${cleanKey(r.customerName)}|${normalizeDate(r.orderDate)}|${num(r.totalRevenue)||num(r.salePrice)}`;
    if(!key || seen.has(key)) return;
    seen.add(key); out.push(r);
  });
  return out;
}

async function readImportFileToRecords(file){
  const ext=(file.name||"").toLowerCase().split(".").pop();
  if(["xlsx","xls"].includes(ext)){
    if(!window.XLSX) throw new Error("Biblioteca Excel não carregada. Verifique sua internet ou salve a planilha como CSV.");
    const buf=await file.arrayBuffer();
    const wb=XLSX.read(buf,{type:"array"});
    const ws=wb.Sheets[wb.SheetNames[0]];
    const rows=XLSX.utils.sheet_to_json(ws,{defval:""});
    return rows.map(r=>{const o={}; Object.entries(r).forEach(([k,v])=>o[normalizeHeader(k)]=v); return o;});
  }
  const text=await file.text();
  const matrix=parseCSVText(text);
  if(matrix.length<2) return [];
  const headers=uniqueHeaders(matrix[0]);
  return matrix.slice(1).map(r=>{const obj={}; headers.forEach((h,i)=>{ if(h) obj[h]=r[i]||""; }); return obj;});
}
async function previewCsv(){
  const file=$("csvFile").files[0];
  if(!file) return alert("Selecione uma planilha Excel (.xlsx) ou CSV.");
  try{
    const records=await readImportFileToRecords(file);
    if(!records.length) return alert("Arquivo sem linhas suficientes.");
    const mapped=records.filter(r=>!isBlankRecord(r)).map(mapCsvRecord).filter(r=>r.amazonOrderId || r.productName || r.customerName);
    csvRowsToImport=uniqueCsvRecords(mapped);
    const ignored=mapped.length-csvRowsToImport.length;
    $("csvPreviewPanel").style.display="block";
    $("csvPreviewInfo").textContent=`${csvRowsToImport.length} pedido(s) único(s) encontrados para importação${ignored>0?` · ${ignored} linha(s) vazia(s)/duplicada(s) ignorada(s)`:""}. Campos sem custo Amazon/fornecedor/link ficam pendentes para preencher depois.`;
    $("csvPreviewRows").innerHTML=csvRowsToImport.slice(0,50).map(r=>`<tr><td>${r.amazonOrderId||"-"}</td><td>${r.orderDate||"-"}</td><td>${r.productName||"-"}</td><td>${r.customerName||"-"}</td><td>${brl(revenue(r))}</td><td>${r.status}${!r.amazonFees?' · Amazon pendente':''}${!(r.totalSupplier||r.buyPrice)?' · Fornecedor pendente':''}</td></tr>`).join("");
  }catch(err){console.error(err);alert(err.message||"Não foi possível ler a planilha. Tente salvar como CSV.");}
}
function findOrCreateProductCsv(d){
  let arr=read(K.products);
  let p=arr.find(x=>sameSkuOrAsin(x,d) || sameProductName(x.name,d.productName));
  if(p){
    // Completa dados vazios do produto existente, sem sobrescrever o que você já editou manualmente.
    const ix=arr.findIndex(x=>x.id===p.id);
    const updated={...p};
    if(!updated.asin && d.asin) updated.asin=d.asin;
    if(!updated.sku && d.sku) updated.sku=d.sku;
    if(!updated.supplierId && d.supplierId) updated.supplierId=d.supplierId;
    if(!updated.buyLink && d.buyLink) updated.buyLink=d.buyLink;
    if(!num(updated.buyPrice) && d.buyPrice) updated.buyPrice=d.buyPrice;
    if(!num(updated.buyShipping) && d.buyShipping) updated.buyShipping=d.buyShipping;
    if(!num(updated.salePrice) && d.salePrice) updated.salePrice=d.salePrice;
    if(!num(updated.saleShipping) && d.saleShipping) updated.saleShipping=d.saleShipping;
    if(!num(updated.amazonFees) && d.amazonFees) updated.amazonFees=d.amazonFees;
    if(ix>=0){arr[ix]=updated; write(K.products,arr);}
    return updated;
  }
  p={id:uuid(),name:d.productName||"Produto importado Excel/CSV",category:"Importado Excel/CSV",asin:d.asin||"",sku:d.sku||"",supplierId:d.supplierId,buyLink:d.buyLink||"",status:"Ativo na Amazon",buyPrice:d.buyPrice||0,buyShipping:d.buyShipping||0,salePrice:d.salePrice,saleShipping:d.saleShipping,amazonFees:d.amazonFees||0,notes:"Criado pela importação Excel/CSV V13.8.4. Produto validado por ASIN/SKU/nome normalizado."};
  arr.push(p);write(K.products,arr);return p;
}
let csvImporting=false;
function setCsvStatus(msg, type="info"){
  const el=$("csvImportStatus");
  if(el){
    el.textContent=msg||"";
    el.className=`muted csvStatus ${type}`;
    el.style.display=msg?"block":"none";
  }
}
async function importCsvRows(event){
  if(event && event.preventDefault) event.preventDefault();
  if(csvImporting) return;
  const previousSyncPaused = NPC_SYNC_PAUSED;
  try{
    if(!csvRowsToImport.length){
      setCsvStatus("Faça a pré-visualização primeiro antes de importar.", "warn");
      return alert("Faça a pré-visualização primeiro.");
    }
    csvImporting=true;
    NPC_SYNC_PAUSED=true; // evita sincronizações paralelas durante importação em massa
    const btn=$("importCsvBtn");
    if(btn) btn.disabled=true;
    let orders=read(K.orders), imported=0, skipped=0;
    const before=orders.length;
    csvRowsToImport.forEach(d=>{
      const incomingKey = `${normalizeOrderId(d.amazonOrderId)}|${normalizeProductName(d.productName)}|${num(d.totalRevenue)||num(d.salePrice)}|${num(d.quantity)||1}`;
      const duplicated = incomingKey.replace(/\|/g,"") && orders.some(o=>`${normalizeOrderId(o.amazonOrderId)}|${normalizeProductName(o.productName)}|${num(o.totalRevenue)||num(o.salePrice)}|${num(o.quantity)||1}`===incomingKey);
      if(duplicated){skipped++; return;}
      const p=findOrCreateProductCsv(d);
      let o={id:uuid(),orderDate:d.orderDate||today(),amazonOrderId:d.amazonOrderId||`CSV-${Date.now()}-${imported+1}`,productId:p.id,productName:p.name,customerName:d.customerName||"Cliente não informado",customerPhone:d.customerPhone||"",customerCep:d.customerCep||"",customerAddress:d.customerAddress||"",customerNumber:d.customerNumber||"",customerComplement:d.customerComplement||"",customerDistrict:d.customerDistrict||"",customerCity:d.customerCity||"",customerUf:d.customerUf||"",supplierId:d.supplierId||p.supplierId||"",buyLink:d.buyLink||"",status:d.status||"Venda realizada Amazon",salePrice:num(d.salePrice),saleShipping:num(d.saleShipping),quantity:num(d.quantity)||1,totalRevenue:num(d.totalRevenue),buyPrice:num(d.buyPrice),buyShipping:num(d.buyShipping),buyDiscount:num(d.buyDiscount),totalSupplier:num(d.totalSupplier),supplierQuantity:num(d.supplierQuantity)||num(d.quantity)||1,amazonFees:num(d.amazonFees),netProfit:num(d.netProfit),hasNetProfit:!!d.hasNetProfit,trackingCode:d.trackingCode||"",trackingSent:d.trackingSent||"Não",messageTemplateId:read(K.messages)[1]?.id||"",notes:d.notes||"Importado por Excel/CSV V13.2.",createdAt:new Date().toISOString()};
      o.customerId=upsertCustomer(o);
      orders.push(o); imported++;
    });
    write(K.orders,orders);
    // V13.8.1: sincroniza na ordem correta para respeitar as FK do Supabase.
    // Produtos/clientes/mensagens precisam existir antes dos pedidos.
    NPC_SYNC_PAUSED=false;
    if(imported>0){
      await syncDataNameToSupabase("suppliers");
      await syncDataNameToSupabase("products");
      await syncDataNameToSupabase("customers");
      await syncDataNameToSupabase("messages");
      await syncDataNameToSupabase("orders");
    }
    await logCsvImport({nome_arquivo:$("csvFile")?.files?.[0]?.name||"CSV importado",origem:"Amazon",total_linhas:csvRowsToImport.length,importados:imported,ignorados:skipped,erros:0,observacoes:`Importação realizada pela V13.8. Antes: ${before}.`});
    const after=read(K.orders).length;
    render();
    setCsvStatus(`${imported} pedido(s) importado(s). ${skipped} duplicado(s) ignorado(s). Total de pedidos: ${before} → ${after}.`, imported?"success":"warn");
    alert(`${imported} pedido(s) importado(s). ${skipped} duplicado(s) ignorado(s) por pedido/produto/valor.`);
    if(imported>0) openView("orders");
  }catch(err){
    console.error("Erro ao importar CSV", err);
    setCsvStatus(`Erro ao importar: ${err.message||err}`, "error");
    alert(`Erro ao importar CSV: ${err.message||err}`);
  }finally{
    NPC_SYNC_PAUSED=previousSyncPaused;
    csvImporting=false;
    const btn=$("importCsvBtn");
    if(btn) btn.disabled=false;
  }
}
function downloadCsvTemplate(){
  const headers=["id venda","produto","Preço venda","Quantidade","Frete","Total","Endereço de entrega","Preço fornecedor","Quantidade fornecedor","Frete do fornecedor","Desconto","Total fornecedor","Custo Amazon","Lucro","Cliente","Telefone","data da venda","status","Fornecedor comprado","Link do produto"];
  const sample=["701-0000000-0000000","Produto Exemplo","59,90","1","19,90","79,80","Rua Exemplo 123 Apto 1 Centro Rio de Janeiro, RJ 20040002","35,00","1","0","0","35,00","0","44,80","Cliente Exemplo","21999999999",today(),"Venda realizada Amazon","Shopee","https://shopee.com.br/"];
  const csv=[headers,sample].map(r=>r.join(";")).join("\n");
  const blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8;"});
  const url=URL.createObjectURL(blob), a=document.createElement("a");a.href=url;a.download="modelo-importacao-vendas-neo-prime.csv";a.click();URL.revokeObjectURL(url);
}
function clearCsv(){
  csvRowsToImport=[];$("csvFile").value="";$("csvPreviewPanel").style.display="none";$("csvPreviewRows").innerHTML="";
}

function getSettingsFromForm(){return {storeName:$("storeName").value,storeOwner:$("storeOwner").value,storeWhatsapp:$("storeWhatsapp").value,storeWhatsappMode:$("storeWhatsappMode")?.value||"web",storeMarketplace:$("storeMarketplace").value,storeColor:$("storeColor").value,storeStatus:$("storeStatus").value,storeNotes:$("storeNotes").value,updatedAt:new Date().toISOString()};}
function loadSettings(){const st=JSON.parse(localStorage.getItem(K.settings)||"{}");Object.entries({storeName:st.storeName||"Neo Prime Box",storeOwner:st.storeOwner||"José",storeWhatsapp:st.storeWhatsapp||"+55 21 96869-2887",storeWhatsappMode:st.storeWhatsappMode||"web",storeMarketplace:st.storeMarketplace||"Amazon",storeColor:st.storeColor||"Azul / Roxo",storeStatus:st.storeStatus||"Ativa",storeNotes:st.storeNotes||"Controle de vendas Amazon e dropshipping."}).forEach(([k,v])=>{if($(k)&&v!==undefined)$(k).value=v;});}
function collectBackup(){
  const storage={};
  Object.values(K).forEach(key=>{storage[key]=localStorage.getItem(key)});
  return {app:"Neo Prime Control",version:APP_VERSION,dbType:"supabase-relacional-portugues-db-first",exportedAt:new Date().toISOString(),
    products:read(K.products),orders:read(K.orders),customers:read(K.customers),suppliers:read(K.suppliers),messages:read(K.messages),settings:JSON.parse(localStorage.getItem(K.settings)||"{}"),storage};
}
function downloadJson(data,filename){const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);}
function restoreBackup(data){
  // Importa backups novos e antigos sem depender do prefixo da versão.
  if(data.storage){
    ["products","orders","customers","suppliers","messages","settings"].forEach(name=>{
      const possible=Object.keys(data.storage).filter(k=>k.endsWith(`_${name}`));
      let best="";
      for(const k of possible){
        const value=data.storage[k];
        if(value!==null && value!==undefined){best=k;}
      }
      if(best){
        if(name==="settings") localStorage.setItem(K.settings,data.storage[best]);
        else localStorage.setItem(K[name],data.storage[best]);
      }
    });
  }
  ["products","orders","customers","suppliers","messages"].forEach(k=>{if(Array.isArray(data[k]))write(K[k],data[k]);});
  if(data.settings) localStorage.setItem(K.settings,JSON.stringify(data.settings));
  localStorage.setItem(K.seeded,"1");
  if(NPC_APP_STARTED && !NPC_SYNC_PAUSED){["suppliers","products","customers","messages","orders"].forEach(scheduleSupabaseSync);syncSettingsToSupabase();}
}
$("settingsForm").onsubmit=e=>{e.preventDefault();localStorage.setItem(K.settings,JSON.stringify(getSettingsFromForm()));syncSettingsToSupabase();alert("Configurações salvas e sincronizadas com Supabase quando configurado.");};
$("exportBackupBtn").onclick=()=>{localStorage.setItem(K.settings,JSON.stringify(getSettingsFromForm()));const data=collectBackup();const nome=`neo-prime-control-v13-8-banco-json-${today()}.json`;logBackup(data,nome);downloadJson(data,nome);};
$("testStoreWhatsappBtn").onclick=()=>{localStorage.setItem(K.settings,JSON.stringify(getSettingsFromForm()));testStoreWhatsapp();};
$("importBackupBtn").onclick=()=>$("importBackupFile").click();$("importBackupFile").onchange=async e=>{const f=e.target.files[0];if(!f)return;try{const data=JSON.parse(await f.text());if(!confirm("Importar backup e substituir dados atuais? Faça isso apenas com backup confiável."))return;restoreBackup(data);loadSettings();render();alert("Backup importado com sucesso.");}catch(err){alert("Não foi possível importar o backup. Verifique se o arquivo é JSON válido.");}finally{e.target.value="";}};

if($("previewCsvBtn")) $("previewCsvBtn").onclick=previewCsv;
if($("importCsvBtn")) $("importCsvBtn").onclick=importCsvRows;
if($("downloadCsvTemplateBtn")) $("downloadCsvTemplateBtn").onclick=downloadCsvTemplate;
if($("clearCsvBtn")) $("clearCsvBtn").onclick=clearCsv;
window.npcImportCsv=importCsvRows;
window.npcPreviewCsv=previewCsv;
window.npcClearCsv=clearCsv;

function updateOrderCalcPreview(){
  if(!$("orderCalcPreview")) return;
  const d={salePrice:num($("salePrice").value),saleShipping:num($("saleShipping").value),buyPrice:num($("buyPrice").value),buyShipping:num($("buyShipping").value),buyDiscount:num($("buyDiscount").value),amazonFees:num($("amazonFees").value)};
  $("orderCalcPreview").innerHTML=`<span class="calcLabel">Receita</span> <span class="calcValue">${brl(revenue(d))}</span> • <span class="calcLabel">Fornecedor</span> <span class="calcValue">${brl(num(d.buyPrice)+num(d.buyShipping)-num(d.buyDiscount))}</span> • <span class="calcLabel">Amazon</span> <span class="calcAmazon">${brl(d.amazonFees)}</span> • <span class="calcLabel">Lucro líquido</span> <span class="calcProfit">${brl(profit(d))}</span> • <span class="calcLabel">Margem</span> <span class="calcMargin">${margin(profit(d),revenue(d)).toFixed(1)}%</span>`;
}
function updateProductCalcPreview(){
  if(!$("productCalcPreview")) return;
  const p={salePrice:num($("productSalePrice").value),saleShipping:num($("productSaleShipping").value),buyPrice:num($("productBuyPrice").value),buyShipping:num($("productBuyShipping").value),amazonFees:num($("productAmazonFees").value)};
  $("productCalcPreview").innerHTML=`<span class="calcLabel">Receita padrão</span> <span class="calcValue">${brl(productRevenue(p))}</span> • <span class="calcLabel">Custo fornecedor</span> <span class="calcValue">${brl(productCost(p))}</span> • <span class="calcLabel">Amazon</span> <span class="calcAmazon">${brl(p.amazonFees)}</span> • <span class="calcLabel">Lucro esperado</span> <span class="calcProfit">${brl(productExpectedProfit(p))}</span> • <span class="calcLabel">Margem</span> <span class="calcMargin">${margin(productExpectedProfit(p),productRevenue(p)).toFixed(1)}%</span>`;
}
["salePrice","saleShipping","buyPrice","buyShipping","buyDiscount","amazonFees"].forEach(id=>{if($(id)) $(id).addEventListener("input",updateOrderCalcPreview);});
["productSalePrice","productSaleShipping","productBuyPrice","productBuyShipping","productAmazonFees"].forEach(id=>{if($(id)) $(id).addEventListener("input",updateProductCalcPreview);});

function render(){
  renderSelects(); renderDashboard(); renderAmazonMetrics(); renderOrdersTable(); renderProducts(); renderCustomers(); renderSuppliers(); renderMessages(); renderFinance(); renderReports(); renderAnalytics(); updateOrderCalcPreview(); updateProductCalcPreview();
}
window.editOrder=editOrder;window.delOrder=delOrder;window.markSent=markSent;window.sendWa=sendWa;window.sendTrackingWa=sendTrackingWa;window.testStoreWhatsapp=testStoreWhatsapp;
window.refreshWaPreview=refreshWaPreview;window.confirmWhatsappMessage=confirmWhatsappMessage;window.closeWhatsappMessage=closeWhatsappMessage;
window.editProduct=editProduct;window.delProduct=delProduct;window.archiveProduct=archiveProduct;
window.editSupplier=editSupplier;window.delSupplier=delSupplier;window.editMessage=editMessage;window.delMessage=delMessage;
window.openCustomerOrders=openCustomerOrders;window.openCustomerEdit=openCustomerEdit;window.closeCustomerOrders=closeCustomerOrders;window.closeCustomerEdit=closeCustomerEdit;

// V12.1 - fallback final: se algum navegador perder o onclick, o clique ainda funciona por delegação.
document.addEventListener("click", function(e){
  const id=e.target && e.target.id;
  // Fallback sem duplicar execução: se o botão já tem onclick registrado, deixa o próprio botão tratar.
  if(e.target && typeof e.target.onclick === "function") return;
  if(id==="analyzeJsonBtn" && window.npcAnalyzeJson) return window.npcAnalyzeJson(e);
  if(id==="clearAiBtn" && window.npcClearAi) return window.npcClearAi(e);
  if(id==="importCsvBtn" && window.npcImportCsv) return window.npcImportCsv(e);
  if(id==="clearCsvBtn" && window.npcClearCsv) return window.npcClearCsv(e);
  if(id==="previewCsvBtn" && window.npcPreviewCsv) return window.npcPreviewCsv(e);
}, true);

async function startApp(){
  if($("orderDate")) $("orderDate").value=today();
  if($("closeCustomerOrdersBtn")) $("closeCustomerOrdersBtn").onclick=closeCustomerOrders;
  if($("closeCustomerEditBtn")) $("closeCustomerEditBtn").onclick=closeCustomerEdit;
  if($("cancelCustomerEditBtn")) $("cancelCustomerEditBtn").onclick=closeCustomerEdit;
  if($("customerEditForm")) $("customerEditForm").onsubmit=saveCustomerEdit;
  setupAi();
  updateSearchPlaceholder();

  if(supabaseConfigured()){
    NPC_APP_STARTED=true;
    await loadSupabaseToLocalOrUploadLocal();
  }else{
    // Modo fallback para desenvolvimento local sem Supabase configurado.
    // Em produção, configure supabase-config.js para usar somente o banco.
    seed();
    migrateV102();
    loadSettings();
    NPC_APP_STARTED=true;
    render();
    setSyncStatus("Supabase não configurado. Usando modo local de desenvolvimento.","error");
  }
}
startApp();
