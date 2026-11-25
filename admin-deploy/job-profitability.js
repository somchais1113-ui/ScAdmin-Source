/* SCWork V2.1.34 — Phase 03 / Job Profitability. PRIVATE ONLY.
 * This module cannot issue, revise or publish a Public Rate Card.
 * The server RPCs revalidate all amounts, roles and AAL2 before persisting anything.
 */
(() => {
 'use strict';
 const $=id=>document.getElementById(id);
 if(!$('tab-jobs'))return;
 const E=window.SCWORK_JOB_ENGINE;
 const direct=[['supplier_total','ค่าจ้างผลิต Supplier'],['extra_materials','วัสดุเพิ่มเติม'],['packaging','แพ็กสินค้า'],['outbound_freight','ขนส่งออก'],['machine_energy','พลังงานเครื่องภายใน'],['outside_services','บริการภายนอก']];
 const all=[...direct,['direct_labor','ค่าแรง Direct Labor'],['allocated_overhead','Overhead จัดสรร'],['b2b_admin_fee','B2B Admin'],['payment_fee','Payment Fee'],['financing_cost','Credit / Financing']];
 const labor=[['design','Design'],['prepress','Prepress'],['coordination','ประสานงาน'],['qc','QC'],['packing','Packing'],['production','ผลิตภายใน']];
 const materials={'pp-white':'PP ขาว','pp-clear':'PP ใส','pvc-sqm':'PVC','paper-sticker':'กระดาษขาว','kraft-sticker':'กระดาษคราฟท์','vinyl-banner':'ไวนิล'};
 const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const fmt=n=>'฿'+Number(n).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
 const pct=n=>(Number(n)*100).toLocaleString('th-TH',{maximumFractionDigits:1})+'%';
 const jdate=v=>v?new Date(v).toLocaleDateString('th-TH'):'–';
 const n=(id,label,positive=false)=>{
   const el=$(id),v=el?.value?.trim();if(v==null||v==='')throw Error('กรุณาระบุ '+(label||id));
   const x=Number(v);if(!Number.isFinite(x)||x<0||(positive&&x===0)||x>1e11)throw Error('จำนวนเงิน/เวลาไม่ถูกต้อง: '+(label||id));
   return x;
 };
 const monetary=(id,label,positive=false)=>{const x=n(id,label,positive);if(Math.abs(x*100-Math.round(x*100))>1e-7)throw Error(label+' ต้องไม่เกินทศนิยม 2 ตำแหน่ง');return x};
 const session=()=>window.SCWORK_ADMIN_BRIDGE?.getSession()||{};
 let jobs=[],actuals=[],profiles=[],supplierQuotes=[],selectedId='',loadBusy=false,loaded=false;
 let currentEvents=[];
 const actualMap=()=>{const m=new Map();for(const x of actuals){const prev=m.get(x.job_id);if(!prev||x.revision>prev.revision)m.set(x.job_id,x);}return m};
 function notify(message,kind='info'){$('jobMessage').textContent=message||'';$('jobMessage').dataset.kind=kind;}
 function view(name){document.querySelectorAll('[data-job-view]').forEach(b=>b.classList.toggle('active',b.dataset.jobView===name));document.querySelectorAll('#tab-jobs .job-view').forEach(x=>x.hidden=x.id!=='job-view-'+name);if(name==='detail')renderDetail();}
 function initializeFields(){
  $('jobDate').value=new Date().toLocaleDateString('en-CA');
  for(const [id,title] of direct){const label=document.createElement('label');label.textContent=title+' (บาท)';const field=document.createElement('input');field.id='jobEst_'+id;field.type='number';field.min='0';field.max='100000000000';field.step='0.01';field.required=true;field.value='0';label.appendChild(field);$('jobEstimatedInputs').appendChild(label);}
  for(const [id,title] of labor){const label=document.createElement('label');label.textContent=title+' (ชั่วโมง)';const field=document.createElement('input');field.id='jobLabor_'+id;field.type='number';field.step='0.25';field.min='0';field.max='744';field.value='0';field.required=true;label.appendChild(field);$('jobLaborInputs').appendChild(label);}
  for(const [id,title] of all){const label=document.createElement('label');label.textContent=title+' (บาท)';const field=document.createElement('input');field.type='number';field.id='jobActual_'+id;field.min='0';field.max='100000000000';field.step='0.01';field.required=true;field.placeholder='0 ถ้าไม่มีค่าใช้จ่าย';label.appendChild(field);$('jobActualInputs').appendChild(label);}
 }
 function profileModel(r){return {...r,productive_hours:Number(r.productive_hours),overheads:r.overhead_lines,
  labor_rates:Object.fromEntries((r.labor_rates||[]).map(x=>[x.role,Number(x.rate)])),
  b2c_margin:Number(r.b2c_margin),b2b_margin:Number(r.b2b_margin),b2c_payment_fee:Number(r.b2c_payment_fee),b2b_payment_fee:Number(r.b2b_payment_fee),
  b2b_admin_fee:Number(r.b2b_admin_fee),b2b_credit_days:Number(r.b2b_credit_days),b2b_financing_rate:Number(r.b2b_financing_rate),risk_pct:Number(r.risk_pct)};}
 function selected(){return jobs.find(x=>x.id===selectedId)||null}
 function getProfile(){return profiles.find(x=>x.id===$('jobProfile').value)}
 function collectedInputs(){
  const pro=getProfile();if(!pro)throw Error('เลือก Cost Profile ที่ได้รับอนุมัติก่อน');
  const q=n('jobQuantity','จำนวนชิ้น',true);if(!Number.isInteger(q)||q>100000000)throw Error('จำนวนต้องเป็นจำนวนเต็ม');
  const date=$('jobDate').value;if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('วันที่ใบงานไม่ถูกต้อง');
  if(pro.period_month>date)throw Error('Cost Profile เริ่มใช้หลังวันที่ของใบงาน');
  const estimateInputs={buyer_type:$('jobBuyer').value,selling_price:monetary('jobSale','ราคาขายที่ตกลง',true),activity_hours:n('jobActivity','ชั่วโมงกิจกรรม',true),labor_hours:{}};
  const directCosts={};for(const [k,title] of direct){directCosts[k]=monetary('jobEst_'+k,title);estimateInputs[k]=directCosts[k];}
  for(const [k,title] of labor)estimateInputs.labor_hours[k]=n('jobLabor_'+k,'ชั่วโมง '+title);
  const quote=$('jobSupplierQuote').value||null;
  if(quote){const source=supplierQuotes.find(x=>x.id===quote);if(!source||source.material_id!==$('jobMaterial').value)throw Error('ใบราคา Supplier ไม่ตรงวัสดุ');}
  return {code:$('jobCode').value.trim(),customer:$('jobCustomer').value.trim(),buyer:$('jobBuyer').value,
   material:$('jobMaterial').value,quantity:q,job_date:date,profile_id:pro.id,quote_id:quote,
   selling_price:estimateInputs.selling_price,activity_hours:estimateInputs.activity_hours,
   labor_hours:estimateInputs.labor_hours,direct_costs:directCosts,notes:$('jobNotes').value.trim(),estimateInputs,profile:pro};
 }
 function preview(){
  const x=collectedInputs();if(x.code.length<3||x.customer.length<2)throw Error('กรอกเลขที่งานและลูกค้าให้ครบ');
  const result=E.estimate(x.profile,x.estimateInputs);
  const el=$('jobPreviewResult');el.hidden=false;
  el.innerHTML=`<h3>INTERNAL BUDGET · ยังไม่ใช่ราคาขายที่อนุมัติ</h3><div class="job-result-grid"><div><span>ราคาที่ลูกค้าตกลง</span><strong>${fmt(x.selling_price)}</strong></div><div><span>Estimated Cost</span><strong>${fmt(result.estimate_cost)}</strong></div><div><span>Estimated Profit</span><strong class="${result.estimated_profit<0?'warn':''}">${fmt(result.estimated_profit)}</strong></div></div><p>Estimated Margin <b>${pct(result.estimated_margin)}</b> · Target ${pct(result.target_margin)} ${result.below_target?'· ต่ำกว่าเป้า ต้องทบทวนราคาหรือต้นทุน':''}</p><p>Budget รวม Risk Reserve ${fmt(result.breakdown.risk_reserve)} · ในรายงาน Actual จะไม่นับส่วนนี้เป็นค่าใช้จ่ายจริงโดยอัตโนมัติ</p><p>Server จะคำนวณจาก Cost Profile ที่อนุมัติอีกครั้งก่อนบันทึก เพื่อไม่เชื่อค่าคำนวณจาก Browser เพียงอย่างเดียว</p>`;
  return x;
 }
 function counts(){
  const last=actualMap();
  const closed=jobs.filter(j=>j.status==='closed'&&last.has(j.id));
  $('jobTotal').textContent=jobs.length.toLocaleString('th-TH');
  $('jobOpen').textContent=jobs.filter(j=>j.status==='open').length.toLocaleString('th-TH');
  $('jobClosedSales').textContent=closed.length?fmt(closed.reduce((v,j)=>v+Number(j.selling_price),0)):'–';
  $('jobClosedProfit').textContent=closed.length?fmt(closed.reduce((v,j)=>v+Number(j.selling_price)-Number(last.get(j.id).total_cost),0)):'–';
  const monthly=new Map();for(const j of closed){const m=String(j.closed_at||'').slice(0,7),value=Number(j.selling_price)-Number(last.get(j.id).total_cost);if(!m)continue;const r=monthly.get(m)||{count:0,sales:0,profit:0};r.count++;r.sales+=Number(j.selling_price);r.profit+=value;monthly.set(m,r);}
  const sorted=[...monthly].sort((a,b)=>b[0].localeCompare(a[0])).slice(0,8);
  const max=Math.max(1,...sorted.map(([,x])=>Math.abs(x.profit)));
  $('jobMonthlySummary').innerHTML=sorted.length?sorted.map(([m,x])=>`<div class="job-monthly-row"><span>${esc(m)}</span><div class="job-meter" title="${esc('งาน '+x.count+' ใบงาน')}"><i class="${x.profit<0?'negative':''}" style="width:${Math.max(2,Math.min(100,Math.abs(x.profit)/max*100))}%"></i></div><strong>${fmt(x.profit)}</strong></div>`).join(''):'<p class="muted">ยังไม่มีงานที่ Owner ปิดพร้อม Actual Cost ครบ จึงยังไม่แสดงกำไรจริง</p>';
 }
 function list(){
  const type=$('jobStatusFilter').value,filter=$('jobSearch').value.trim().toLocaleLowerCase(),current=actualMap();
  const rows=jobs.filter(x=>(type==='all'||x.status===type)&&(!filter||[x.job_code,x.customer_label].some(y=>String(y||'').toLocaleLowerCase().includes(filter))));
  $('jobRows').innerHTML=rows.length?rows.map(x=>{const a=current.get(x.id);const closed=x.status==='closed';const prof=a?Number(x.selling_price)-Number(a.total_cost):null;
   return `<tr><td><strong>${esc(x.job_code)}</strong><small>${esc(x.customer_label)}</small></td><td>${esc(x.buyer_type.toUpperCase())}<br><small>${esc(materials[x.material_id]||x.material_id)} · ${Number(x.quantity).toLocaleString('th-TH')}</small></td><td class="money">${fmt(x.selling_price)}</td><td class="money">${fmt(x.estimated_cost)}</td><td class="money">${a?fmt(a.total_cost):'รอบันทึก'}</td><td class="money ${closed&&prof!==null?(prof>=0?'gain':'loss'):''}">${closed&&prof!==null?fmt(prof):'–'}</td><td><span class="job-pill ${closed?'closed':''}">${closed?'ปิดต้นทุน':'เปิดงาน'}</span></td><td><button class="secondary" type="button" data-job-select="${esc(x.id)}">เปิดใบงาน</button></td></tr>`;
  }).join(''):'<tr><td colspan="8">ไม่พบใบงานตามเงื่อนไขที่เลือก</td></tr>';
  $('jobRows').querySelectorAll('[data-job-select]').forEach(b=>b.addEventListener('click',()=>{select(b.dataset.jobSelect);view('detail');}));
 }
 function profileSelect(){const chosen=$('jobProfile').value;
  $('jobProfile').innerHTML='<option value="">เลือก Cost Profile · Approved</option>'+profiles.map(x=>`<option value="${esc(x.id)}">${esc(x.period_month.slice(0,7))} · ${esc(x.id.slice(0,8))}</option>`).join('');
  if(profiles.some(x=>x.id===chosen))$('jobProfile').value=chosen;
 }
 function supplierSelect(){
  const material=$('jobMaterial').value,dt=$('jobDate').value,v=$('jobSupplierQuote').value;
  const available=supplierQuotes.filter(x=>x.material_id===material&&(!x.valid_until||x.valid_until>=dt));
  $('jobSupplierQuote').innerHTML='<option value="">ไม่ผูกใบราคา · กรอกยอดจริงของงาน</option>'+available.map(x=>`<option value="${esc(x.id)}">${esc(x.supplier)} · ${esc(x.document_no)} · ${esc(x.unit)} ${fmt(x.landed_unit_cost)}/หน่วย</option>`).join('');
  if(available.some(x=>x.id===v))$('jobSupplierQuote').value=v;
 }
 function jobSelect(){const el=$('jobSelected'),v=selectedId;el.innerHTML='<option value="">เลือกใบงาน</option>'+jobs.map(x=>`<option value="${esc(x.id)}">${esc(x.job_code)} · ${esc(x.status==='closed'?'ปิดต้นทุน':'เปิดงาน')}</option>`).join('');if(jobs.some(x=>x.id===v))el.value=v;}
 function select(id){selectedId=id;jobSelect();renderDetail();}
 async function load(){
  const {db,member}=session();if(!db||!member||loadBusy)return;
  loadBusy=true;notify('กำลังโหลด Job Costing จากฐานข้อมูลส่วนตัว...');
  try{
   // Fail closed rather than silently showing an incomplete portfolio when results exceed the MVP cap.
   const [j,a,p,q]=await Promise.all([
    db.from('scwork_jobs').select('*',{count:'exact'}).order('created_at',{ascending:false}).limit(1000),
    db.from('scwork_job_actual_snapshots').select('*',{count:'exact'}).order('created_at',{ascending:false}).limit(1000),
    db.from('scwork_cost_profiles').select('*').eq('status','approved').order('period_month',{ascending:false}).limit(100),
    db.from('scwork_supplier_quotes').select('id,supplier,document_no,material_id,unit,landed_unit_cost,valid_until,status').eq('status','approved').limit(300)
   ]);
   for(const r of [j,a,p,q])if(r.error)throw r.error;
   if((j.count??j.data?.length??0)>1000||(a.count??a.data?.length??0)>1000)throw Error('ข้อมูลเกินขอบเขต 1,000 รายการของ Dashboard MVP; ต้องใช้ Pagination/Server-side Reporting ก่อนแสดงยอดรวม');
   jobs=j.data||[];actuals=a.data||[];profiles=(p.data||[]).map(profileModel);supplierQuotes=q.data||[];
   if(selectedId&&!jobs.some(x=>x.id===selectedId))selectedId='';
   counts();list();profileSelect();supplierSelect();jobSelect();renderDetail();loaded=true;
   notify(jobs.length?'โหลดใบงานสำเร็จ · รายงานผลกำไรเฉพาะงานปิดต้นทุนแล้ว':'ยังไม่มีใบงาน · เริ่มด้วยการเปิดใบงานใหม่');
  }catch(err){jobs=[];actuals=[];profiles=[];supplierQuotes=[];counts();list();jobSelect();loaded=false;notify('โหลด Job Profitability ไม่สำเร็จ: '+(err.message||err)+' · ตรวจว่ารัน SQL 003 หลัง SQL 002 แล้ว','error');}
  finally{loadBusy=false;}
 }
 async function create(e){e.preventDefault();const {db,member}=session();if(!db||!member||member.role==='viewer'){notify('บัญชีนี้ไม่มีสิทธิ์เปิดใบงาน','error');return;}
  try{const x=preview();const btn=$('jobCreate');btn.disabled=true;
    try{notify('กำลังสร้างใบงานและคำนวณ Budget ที่ Supabase...');const args={p_code:x.code,p_customer:x.customer,p_buyer:x.buyer,p_material:x.material,p_quantity:x.quantity,p_job_date:x.job_date,p_profile_id:x.profile_id,p_quote_id:x.quote_id,p_sale:x.selling_price,p_direct:x.direct_costs,p_labor_hours:x.labor_hours,p_activity_hours:x.activity_hours,p_notes:x.notes};
     const {data,error}=await db.rpc('scwork_create_job',args);if(error)throw error;
     await load();if(data)select(data);view('detail');notify('สร้างใบงานสำเร็จ · Budget ถูกคำนวณและบันทึกโดย Server แล้ว','success');
    }finally{btn.disabled=false;}
  }catch(err){notify('บันทึกใบงานไม่สำเร็จ: '+(err.message||err),'error');}
 }
 function actualInputs(){const obj={};for(const [k,title] of all)obj[k]=monetary('jobActual_'+k,title);return obj;}
 async function saveActual(e){e.preventDefault();const {db,member}=session(),job=selected();if(!db||!job||job.status!=='open'||!member||member.role==='viewer'){notify('ไม่สามารถบันทึก Actual ให้ใบงานนี้ได้','error');return;}
  try{const actual=actualInputs(),s=E.actual(job,actual),doc=$('jobActualRef').value.trim();if(doc.length<4)throw Error('กรอกเลขเอกสารอ้างอิงต้นทุนจริงอย่างน้อย 4 ตัวอักษร');
   const button=$('jobSaveActual');button.disabled=true;
   try{notify('กำลังสร้าง Actual Snapshot ฉบับใหม่...');const {error}=await db.rpc('scwork_record_job_actual',{p_job_id:job.id,p_actual:actual,p_document_ref:doc,p_notes:$('jobActualNote').value.trim()});if(error)throw error;
    await load();select(job.id);view('detail');notify('บันทึก Actual Revision สำเร็จ · ต้นทุนจริง '+fmt(s.total_cost)+' · ยังไม่ปิดงานจนกว่า Owner จะยืนยัน','success');
   }finally{button.disabled=false;}
  }catch(err){notify('บันทึก Actual ไม่สำเร็จ: '+(err.message||err),'error');}
 }
 async function ownerAction(e,type){e.preventDefault();const {db,member}=session(),j=selected();if(!db||!j||member?.role!=='owner'||j.status!=='open'){notify('เฉพาะ Owner เท่านั้นที่ทำรายการนี้ได้','error');return;}
  let fn,args;
  try{if(type==='price'){fn='scwork_revise_job_sale';args={p_job_id:j.id,p_sale:monetary('jobRevisedSale','ราคาขายใหม่',true),p_reason:$('jobSaleReason').value.trim()};}
  else{fn='scwork_close_job';args={p_job_id:j.id,p_reason:$('jobCloseReason').value.trim()};}
  if(args.p_reason.length<8)throw Error('กรอกเหตุผลอย่างน้อย 8 ตัวอักษร');
  const form=e.target,btn=form.querySelector('button[type=submit]');btn.disabled=true;
  try{notify(type==='price'?'กำลังบันทึกประวัติราคาขายใหม่...':'กำลังปิดต้นทุนและบันทึกผู้อนุมัติ...');const {error}=await db.rpc(fn,args);if(error)throw error;await load();select(j.id);notify(type==='price'?'แก้ยอดขายที่ตกลงแล้ว โดยเก็บ Budget เดิมและ Audit Trail':'Owner ปิดต้นทุนแล้ว และยอดกำไรจะถูกนับเข้ารายงาน','success');}
  finally{btn.disabled=false;}
  }catch(err){notify('ดำเนินการไม่สำเร็จ: '+(err.message||err),'error');}
 }
 function renderDetail(){
  const job=selected(),el=$('jobDetails'),user=session().member;
  if(!job){el.innerHTML='<p class="muted">เลือกใบงานจากทะเบียนก่อน</p>';$('jobActualPanel').hidden=true;$('jobOwnerPanel').hidden=true;$('jobEventRows').textContent='เลือกใบงานก่อน';return;}
  const actual=actualMap().get(job.id),isClosed=job.status==='closed',hasActual=!!actual;
  let metrics='';if(hasActual){const x=E.actual(job,actual.breakdown);metrics=`<div class="job-result-grid"><div><span>Current Selling Price</span><strong>${fmt(job.selling_price)}</strong></div><div><span>Actual Cost · Rev ${Number(actual.revision)}</span><strong>${fmt(actual.total_cost)}</strong></div><div><span>${isClosed?'Closed Job Profit':'Provisional Profit'}</span><strong class="${x.gross_profit<0?'warn':''}">${fmt(x.gross_profit)}</strong></div></div><p class="job-help">Actual Margin ${pct(x.margin)} · ต้นทุนคลาดเคลื่อนจาก Budget ${fmt(x.cost_variance)} · ผลกำไรเปลี่ยนจาก Budget ${fmt(x.profit_variance)} (รวมผลของการปรับราคาขาย)</p>`;}
  else metrics='<p class="job-help">ยังไม่บันทึก Actual Cost จึงไม่แสดงกำไรจริง</p>';
  const rows=[...all,['risk_reserve','Risk Reserve (Budget เท่านั้น)']].map(([k,title])=>{const b=Number(job.estimated_breakdown?.[k]||0),a=k==='risk_reserve'?'–':hasActual?fmt(actual.breakdown?.[k]||0):'รอข้อมูล';return `<tr><td>${esc(title)}</td><td>${fmt(b)}</td><td>${a}</td></tr>`;}).join('');
  el.innerHTML=`<div class="job-detail-head"><div><h3>${esc(job.job_code)}</h3><p>${esc(job.customer_label)} · ${esc(materials[job.material_id]||job.material_id)} · ${Number(job.quantity).toLocaleString('th-TH')} ชิ้น · ${esc(job.buyer_type.toUpperCase())}</p></div><span class="job-pill ${isClosed?'closed':''}">${isClosed?'CLOSED':'OPEN'}</span></div>
  ${metrics}<p class="job-help">Estimated Margin จากราคาตกลงเดิม <b>${pct((Number(job.original_selling_price)-Number(job.estimated_cost))/Number(job.original_selling_price))}</b> · Target Margin ${pct(job.target_margin)} ${((Number(job.original_selling_price)-Number(job.estimated_cost))/Number(job.original_selling_price))<Number(job.target_margin)?"· ต่ำกว่าเป้า ควรทบทวนเงื่อนไขหรือให้ Owner พิจารณา":""}</p><div class="job-detail-scroll"><table class="job-detail-table"><thead><tr><td>Cost Component</td><td>Estimated Budget</td><td>Actual ล่าสุด</td></tr></thead><tbody>${rows}<tr><td>ต้นทุนรวม</td><td>${fmt(job.estimated_cost)}</td><td>${hasActual?fmt(actual.total_cost):'–'}</td></tr></tbody></table></div>
  <p class="job-help">ต้นทุนอ้างอิง Cost Profile ${esc(job.cost_profile_id.slice(0,8))} · เลขอ้างอิงใบราคา Supplier ${job.supplier_quote_id?esc(job.supplier_quote_id.slice(0,8)):'ไม่ได้ผูก'} · เริ่ม ${esc(job.job_date)} ${isClosed?'· ปิด '+esc(jdate(job.closed_at)):''}</p>
  <p class="job-help">ราคาเดิม ${fmt(job.original_selling_price)} · ราคาล่าสุด ${fmt(job.selling_price)} · รายงานผลตอบแทนเป็นยอดขายที่ตกลงแล้ว ไม่ใช่รายรับหลังหัก ณ ที่จ่ายหรือเงินสดที่ได้รับ</p>`;
  $('jobActualPanel').hidden=isClosed||user?.role==='viewer';$('jobOwnerPanel').hidden=isClosed||user?.role!=='owner';
  const staleActual=hasActual && job.updated_at && new Date(actual.created_at).getTime()<new Date(job.updated_at).getTime();
  $('jobCloseForm').querySelector('button[type=submit]').disabled=!hasActual||staleActual;
  $('jobCloseForm').querySelector('.job-help').textContent=staleActual?'หลังปรับราคาขาย ต้องบันทึก Actual Revision ใหม่ก่อนปิดงาน เพื่อทบทวน Fee/Credit':'ทำได้เมื่อตรวจ Actual Snapshot ครบแล้ว กำไรจึงนับเข้ารายงานผลปิดงาน';
  $('jobRevisedSale').value=Number(job.selling_price).toFixed(2);
  for(const [k] of all){const input=$('jobActual_'+k);input.value=hasActual?String(actual.breakdown[k]??''):'';}
  if(!hasActual)$('jobActualRef').value='';
  loadEvents(job.id);
 }
 async function loadEvents(id){const {db}=session();if(!db||!id)return;try{const {data,error}=await db.from('scwork_job_events').select('event_type,event_time,detail').eq('job_id',id).order('event_time',{ascending:false}).limit(60);if(error)throw error;
  if(id!==selectedId)return;currentEvents=data||[];
  $('jobEventRows').innerHTML=currentEvents.length?currentEvents.map(e=>`<div class="job-event"><span>${esc(jdate(e.event_time))}</span><strong>${esc(e.event_type)}</strong><span>${esc(JSON.stringify(e.detail||{}))}</span></div>`).join(''):'<p class="job-help">ยังไม่มีประวัติ</p>';
 }catch(err){if(id===selectedId)$('jobEventRows').textContent='อ่านประวัติไม่สำเร็จ: '+(err.message||err);}}
 function reset(){jobs=[];actuals=[];profiles=[];supplierQuotes=[];selectedId='';loaded=false;counts();list();jobSelect();renderDetail();$('jobPreviewResult').hidden=true;notify('');}
 function init(){
  initializeFields();
  document.querySelectorAll('[data-job-view]').forEach(b=>b.addEventListener('click',()=>view(b.dataset.jobView)));
  document.querySelector('.tabs [data-tab="jobs"]')?.addEventListener('click',()=>{if(!loaded)load();});
  window.addEventListener('scwork-admin-ready',()=>{loaded=false;load();});
  window.addEventListener('scwork-admin-signout',reset);
  $('jobStatusFilter').addEventListener('change',list);$('jobSearch').addEventListener('input',list);
  $('jobReload').addEventListener('click',load);$('jobDetailReload').addEventListener('click',load);
  $('jobSelected').addEventListener('change',e=>select(e.target.value));
  $('jobMaterial').addEventListener('change',supplierSelect);$('jobDate').addEventListener('change',supplierSelect);
  $('jobPreview').addEventListener('click',()=>{try{preview();notify('Budget Preview สำเร็จ · ต้องบันทึกผ่าน Server เพื่อยืนยัน','success');}catch(err){notify(err.message,'error');}});
  $('jobCreateForm').addEventListener('submit',create);
  $('jobActualForm').addEventListener('submit',saveActual);
  $('jobReviseSaleForm').addEventListener('submit',e=>ownerAction(e,'price'));
  $('jobCloseForm').addEventListener('submit',e=>ownerAction(e,'close'));
  if(session().member)load();
 }
 init();
 window.SCWORK_JOB_UI={load,estimate:E.estimate,actual:E.actual};
})();
