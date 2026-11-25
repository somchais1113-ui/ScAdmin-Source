/* SCWork V2.1.34 · Job Profitability (private internal analysis; no selling-rate publication)
 * The cost model follows V2.1.33, but tests profitability against the ACCEPTED sale
 * amount rather than its suggested quotation amount. Financial reports are accrual-like
 * estimates until complete actual costs are recorded and owner closes a job.
 */
(function(root){
 'use strict';
 const C=root.SCWORK_COST_ENGINE;
 if(!C) throw Error('Cost Engine must be loaded before Job Engine');
 const MAX=1e12;
 const COST_KEYS=['supplier_total','extra_materials','packaging','outbound_freight','machine_energy','outside_services','direct_labor','allocated_overhead','b2b_admin_fee','payment_fee','financing_cost'];
 function numeric(value,name,positive=false){return C.amount(value,name,!positive)}
 function cents(value){return Math.round((value+1e-9)*100)/100}
 function money(value){return cents(value)}
 function estimate(profile,input){
  if(!profile||profile.status!=='approved')throw Error('ต้องใช้ Cost Profile ที่อนุมัติแล้วเท่านั้น');
  const buyer=input.buyer_type;
  if(buyer!=='b2c'&&buyer!=='b2b')throw Error('ประเภทผู้ซื้อไม่ถูกต้อง');
  const sale=numeric(input.selling_price,'ราคาขายที่ตกลงแล้ว',true);
  const oh=C.overhead(profile),lab=C.labor(profile,input.labor_hours||{});
  const src={};
  for(const k of COST_KEYS.slice(0,6))src[k]=numeric(input[k],k);
  const activity=numeric(input.activity_hours,'Productive Hours ต่อออเดอร์',true);
  const risk=cents((src.supplier_total+src.extra_materials)*C.ratio(profile.risk_pct||0,'Risk rate'));
  const admin=buyer==='b2b'?numeric(profile.b2b_admin_fee||0,'B2B Admin'):0;
  const feeRate=C.ratio(profile[buyer+'_payment_fee'],'ค่าธรรมเนียม');
  const creditRate=buyer==='b2b'?C.ratio(profile.b2b_financing_rate||0,'ต้นทุนเครดิต')*numeric(profile.b2b_credit_days||0,'เครดิตวัน')/365:0;
  const detail={...src,direct_labor:cents(lab.total),allocated_overhead:cents(activity*oh.perHour),b2b_admin_fee:admin,payment_fee:cents(sale*feeRate),financing_cost:cents(sale*creditRate),risk_reserve:risk};
  const cost=Object.values(detail).reduce((a,b)=>a+b,0);
  if(cost<=0)throw Error('ต้นทุนประมาณการต้องมากกว่า 0');
  const margin=(sale-cost)/sale;
  const target=C.ratio(profile[buyer+'_margin'],'Target Margin');
  return {breakdown:detail,selling_price:sale,estimate_cost:money(cost),estimated_profit:money(sale-cost),estimated_margin:margin,target_margin:target,below_target:margin+1e-9<target,
   labor_hours:lab.hours,activity_hours:activity,source_profile:profile.id||null,buyer_type:buyer,
   notes:'Estimate uses approved cost profile; risk reserve is an estimate, not actual cash spend; withholding is not a selling-price discount'};
 }
 function actual(job,actualCosts){
  const price=numeric(job.selling_price,'ราคาขายที่ตกลงแล้ว',true);
  const breakdown={};for(const k of COST_KEYS)breakdown[k]=numeric(actualCosts[k],k);
  const total=Object.values(breakdown).reduce((a,b)=>a+b,0);
  if(total<=0)throw Error('ต้นทุนจริงต้องมากกว่า 0');
  const estimateCost=numeric(job.estimated_cost,'ต้นทุนประมาณการ');
  const originalPrice=numeric(job.original_selling_price==null?price:job.original_selling_price,'ราคาเดิม');
  return {total_cost:money(total),gross_profit:money(price-total),margin:(price-total)/price,
   cost_variance:money(total-estimateCost),price_variance:money(price-originalPrice),
   profit_variance:money((price-total)-(originalPrice-estimateCost)),breakdown};
 }
 root.SCWORK_JOB_ENGINE={COST_KEYS,estimate,actual};
 if(typeof module!=='undefined'&&module.exports)module.exports=root.SCWORK_JOB_ENGINE;
})(typeof window==='undefined'?globalThis:window);
