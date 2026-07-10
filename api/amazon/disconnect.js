const {cookie,json}=require('./_lib');module.exports=(req,res)=>{res.setHeader('Set-Cookie',cookie('npc_amazon_refresh','',0));json(res,200,{ok:true});};
