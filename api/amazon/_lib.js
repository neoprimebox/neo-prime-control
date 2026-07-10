const crypto = require('crypto');
const MARKETPLACE_BR='A2Q3Y263D00KWC';
const SP_ENDPOINT='https://sellingpartnerapi-na.amazon.com';
function env(name){const v=process.env[name];if(!v)throw new Error(`Variável ${name} não configurada.`);return v;}
function parseCookies(req){return Object.fromEntries(String(req.headers.cookie||'').split(';').filter(Boolean).map(x=>{const i=x.indexOf('=');return [x.slice(0,i).trim(),decodeURIComponent(x.slice(i+1))]}));}
function secretKey(){return crypto.createHash('sha256').update(env('AMAZON_TOKEN_SECRET')).digest();}
function encrypt(value){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',secretKey(),iv);const enc=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),enc]).toString('base64url');}
function decrypt(value){const b=Buffer.from(value,'base64url'),iv=b.subarray(0,12),tag=b.subarray(12,28),enc=b.subarray(28);const d=crypto.createDecipheriv('aes-256-gcm',secretKey(),iv);d.setAuthTag(tag);return Buffer.concat([d.update(enc),d.final()]).toString('utf8');}
function cookie(name,value,maxAge=31536000){return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;}
function getRefreshToken(req){const c=parseCookies(req).npc_amazon_refresh;if(c)return decrypt(c);if(process.env.AMAZON_REFRESH_TOKEN)return process.env.AMAZON_REFRESH_TOKEN;return null;}
async function lwa(refreshToken){const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:refreshToken,client_id:env('AMAZON_LWA_CLIENT_ID'),client_secret:env('AMAZON_LWA_CLIENT_SECRET')});const r=await fetch('https://api.amazon.com/auth/o2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});const j=await r.json();if(!r.ok)throw new Error(j.error_description||j.error||'Falha ao obter access token.');return j.access_token;}
async function sp(req,path){const rt=getRefreshToken(req);if(!rt)throw new Error('Conta Amazon ainda não autorizada.');const token=await lwa(rt);const r=await fetch(`${SP_ENDPOINT}${path}`,{headers:{'x-amz-access-token':token,'content-type':'application/json','user-agent':'NeoPrimeControl/21.0'}});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.errors?.[0]?.message||`SP-API HTTP ${r.status}`);return j;}
async function sellerContext(req){const j=await sp(req,'/sellers/v1/marketplaceParticipations');const payload=j.payload||j;const p=(payload||[]).find(x=>x.marketplace?.id===MARKETPLACE_BR)||(payload||[])[0];return {sellerId:p?.participation?.sellerId||p?.sellerId||'',marketplaceId:p?.marketplace?.id||MARKETPLACE_BR,name:p?.marketplace?.name||'Amazon Brasil'};}
function json(res,status,data){res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.end(JSON.stringify(data));}
module.exports={env,encrypt,cookie,getRefreshToken,lwa,sp,sellerContext,json,MARKETPLACE_BR};
