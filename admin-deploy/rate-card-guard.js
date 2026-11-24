/* SCWork Phase 04 — strict public selling-rate payload validator.
 * Rejects all unknown fields (including hidden costs), demo data and VAT on SCWork sales.
 * Front-end checks are UX defense in depth. Supabase SQL 004 is the authoritative gate.
 */
(function(root){
 'use strict';
 const ids=new Set(['paper-sticker','kraft-sticker','pp-white','pp-clear','pvc-sqm','vinyl-banner']);
 const max=(n,high=100000000)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=high;
 const validText=(s,min=1,limit=150)=>typeof s==='string'&&s.trim().length>=min&&s.length<=limit;
 function fail(m){throw new Error(m);}
 function keys(obj,allowed){if(!obj||typeof obj!=='object'||Array.isArray(obj))fail('Expected structured object');for(const k of Object.keys(obj))if(!allowed.includes(k))fail('Private/unexpected field: '+k);}
 function same(a,b){return JSON.stringify(a)===JSON.stringify(b);}
 function tiers(t,minimum,area){
  if(!Array.isArray(t)||!t.length||t.length>24)fail('Missing/oversized tiers');
  let previous=null,price=null;
  t.forEach((v,i)=>{
   keys(v,['min','max','price','label']);
   if(!max(v.min)||v.min<=0||!max(v.price)||v.price<=0||!validText(v.label,0,100))fail('Invalid tier');
   if(!area&&!Number.isInteger(v.min))fail('Non-integer quantity tier');
   if(v.max!==null&&(!max(v.max)||v.max<v.min||(!area&&!Number.isInteger(v.max))))fail('Invalid tier maximum');
   if(i===0&&v.min!==minimum)fail('First tier does not start at minimum');
   if(i>0&&(previous===null||v.min!==previous+1||v.price>price))fail('Tier gap or increasing unit price');
   previous=v.max;price=v.price;
  });
  if(previous!==null)fail('Final tier must be open ended');
 }
 function addon(a){keys(a,['id','name','type','price']);if(!/^[a-z0-9_-]{2,45}$/.test(a.id||'')||!validText(a.name,2,110)||!['flat','per_unit'].includes(a.type)||!max(a.price))fail('Invalid addon');}
 function validate(raw){
  if(!raw||JSON.stringify(raw).length>100000)fail('Rate Card missing/too large');
  keys(raw,['status','demonstrationOnly','version','approvedAt','vatRate','a3PlusSheet','categories']);
  if(raw.status!=='approved'||raw.demonstrationOnly!==false||raw.vatRate!==0)fail('Unapproved/demo/VAT card rejected');
  if(!/^[A-Za-z0-9._-]{1,45}$/.test(raw.version||'')||!validText(raw.approvedAt,16,50)||!Number.isFinite(Date.parse(raw.approvedAt)))fail('Invalid version/timestamp');
  const s=raw.a3PlusSheet;keys(s,['usableWidthCm','usableHeightCm','gapCm']);
  if(!max(s.usableWidthCm,200)||s.usableWidthCm<=0||!max(s.usableHeightCm,300)||s.usableHeightCm<=0||!max(s.gapCm,10))fail('Invalid A3 print geometry');
  if(!Array.isArray(raw.categories)||raw.categories.length!==1)fail('Invalid category count');
  const c=raw.categories[0];keys(c,['id','name','materials']);if(c.id!=='sticker'||!validText(c.name,2,100)||!Array.isArray(c.materials)||c.materials.length<1||c.materials.length>6)fail('Invalid sticker category');
  const seen=new Set();
  for(const m of c.materials){
   keys(m,['id','name','description','mode','unitLabel','minSheets','minAreaSqm','minQty','defaultQty','tiers','ratePerSqm','minimumCharge','addons','pricingMode','buyerRates']);
   const area=m.id==='pvc-sqm'||m.id==='vinyl-banner';
   if(!ids.has(m.id)||seen.has(m.id)||(area?m.mode!=='area_sqm':m.mode!=='a3_sheet'))fail('Unknown/repeated material/mode');seen.add(m.id);
   if(!validText(m.name,2,140)||!validText(m.unitLabel,1,45)||typeof m.description!=='string'||m.description.length>450||/\d+\s*(?:฿|บาท)/u.test(m.description)||!max(m.minimumCharge,1000000000))fail('Invalid/stale price in material description or minimum');
   if(area){if(!max(m.minAreaSqm)||m.minAreaSqm<=0||!max(m.ratePerSqm)||m.ratePerSqm<=0)fail('Invalid area rates');}
   else if(!Number.isInteger(m.minSheets)||m.minSheets<1||m.pricingMode!=='tier_floor')fail('Invalid sheet count/guard');
   tiers(m.tiers,area?m.minAreaSqm:m.minSheets,area);
   if(area&&(m.tiers.length!==1||m.tiers[0].price!==m.ratePerSqm))fail('Area rate/tier mismatch');
   if(!Array.isArray(m.addons)||m.addons.length>15)fail('Invalid addons');const ad=new Set();
   for(const a of m.addons){addon(a);if(ad.has(a.id))fail('Duplicate addons');ad.add(a.id);}
   if(m.buyerRates!==undefined){
    keys(m.buyerRates,['company']);const b=m.buyerRates.company;keys(b,['tiers','ratePerSqm','minimumCharge','addons']);
    if(!max(b.minimumCharge,1000000000)||!Array.isArray(b.tiers)||b.tiers.length!==m.tiers.length)fail('Invalid company rates');
    for(let i=0;i<b.tiers.length;i++){
      const t=b.tiers[i],retail=m.tiers[i];keys(t,['min','max','price','label']);
      if(t.min!==retail.min||t.max!==retail.max||!max(t.price)||t.price<=0||!validText(t.label,0,100))fail('B2B tier mismatch');
    }
    if(area&&b.ratePerSqm!==b.tiers[0].price)fail('B2B area mismatch');
    if(!Array.isArray(b.addons)||b.addons.length>15)fail('Invalid company addons');
    const bs=new Set();for(const a of b.addons){addon(a);if(!ad.has(a.id)||bs.has(a.id)||m.addons.find(x=>x.id===a.id)?.type!==a.type)fail('B2B addon mismatch');bs.add(a.id);}
   }
  }
  return JSON.parse(JSON.stringify(raw));
 }
 function parseExport(text){
  if(typeof text!=='string'||text.length>150000)fail('File must be a small rate-card JSON/JS export');
  const trim=text.trim();let obj;
  if(trim.startsWith('{'))obj=JSON.parse(trim);
  else {
   const pos=trim.indexOf('window.SCWORK_PRICING_PUBLIC');
   if(pos<0)fail('Expected Pricing Master selling-rate export');
   const after=trim.slice(pos).match(/^window\.SCWORK_PRICING_PUBLIC\s*=\s*([\s\S]*?)\s*;\s*$/);
   if(!after)fail('Only Pricing Master JSON assignment accepted; no executable code');
   obj=JSON.parse(after[1]);
  }
  return validate(obj);
 }
 const api={validate,parseExport};root.SCWORK_RATE_CARD_GUARD=api;
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
