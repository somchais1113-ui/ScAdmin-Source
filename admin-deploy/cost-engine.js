/* SCWork Cost Engine V2.1.33 — internal estimates only, never a Public Rate Card.
 * Monetary inputs represent THB; no output VAT while SCWork is not VAT registered.
 * The caller MUST validate approved source data and never use this preview as an issued quotation.
 */
(function (root) {
  'use strict';
  const MAX = 1e12;
  function amount(value, label, allowZero = true) {
    if (value === '' || value === null || value === undefined) throw Error('ต้องระบุ ' + label);
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > MAX || (!allowZero && n === 0)) throw Error(label + ' ต้องเป็นตัวเลขที่ถูกต้อง');
    return n;
  }
  function ratio(value, label) {
    const n = amount(value, label);
    if (n >= 1) throw Error(label + ' ต้องน้อยกว่า 100%');
    return n;
  }
  function rounded(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }
  function overhead(profile) {
    const hours = amount(profile.productive_hours, 'ชั่วโมงทำงานต่อเดือน', false);
    const lines = Array.isArray(profile.overheads) ? profile.overheads : [];
    if (!lines.length) throw Error('ยังไม่มีรายการค่าใช้จ่ายรายเดือน');
    const components = lines.map(x => {
      const val = amount(x.amount, 'ค่าใช้จ่ายรายเดือน');
      const share = amount(x.allocation, 'สัดส่วนธุรกิจ');
      if (share > 1) throw Error('สัดส่วนธุรกิจต้องไม่เกิน 100%');
      return { label: String(x.label || '').trim(), allocated: val * share, recorded: val };
    });
    const monthly = components.reduce((s, x) => s + x.allocated, 0);
    if (monthly <= 0) throw Error('ยอดค่าใช้จ่ายรายเดือนสำหรับธุรกิจต้องมากกว่า 0');
    return { monthly, hours, perHour: monthly / hours, components };
  }
  function labor(profile, hoursByRole) {
    const rates = profile.labor_rates || {};
    let total = 0, hours = 0;
    const rows = [];
    Object.entries(hoursByRole || {}).forEach(([role, value]) => {
      const h = amount(value, 'ชั่วโมงงาน ' + role);
      if (h <= 0) return;
      if (!Object.prototype.hasOwnProperty.call(rates, role) || rates[role] === '' || rates[role] == null) {
        throw Error('ยังไม่มีต้นทุนค่าแรงต่อชั่วโมงสำหรับ ' + role);
      }
      const rate = amount(rates[role], 'อัตราค่าแรง ' + role, false);
      const subtotal = h * rate;
      total += subtotal; hours += h;
      rows.push({ role, hours: h, rate, total: subtotal });
    });
    return { total, hours, rows };
  }
  function quote(profile, order) {
    if (!profile || !order) throw Error('ยังไม่มี Cost Profile');
    const oh = overhead(profile);
    const variableSupplier = amount(order.supplier_total, 'ค่าจ้างผลิต Supplier');
    const otherMaterials = amount(order.extra_materials || 0, 'วัสดุเพิ่มเติม');
    const packaging = amount(order.packaging || 0, 'ค่าบรรจุภัณฑ์');
    const outbound = amount(order.outbound_freight || 0, 'ค่าขนส่งออก');
    const machineEnergy = amount(order.machine_energy || 0, 'พลังงานเครื่องจักร');
    const outsideServices = amount(order.outside_services || 0, 'บริการภายนอก');
    const laborTotal = labor(profile, order.labor_hours || {});
    const workingHours = amount(order.activity_hours, 'ชั่วโมงกิจกรรมออเดอร์', false);
    const riskRate = ratio(profile.risk_pct || 0, 'สัดส่วนสำรองของเสีย');
    // Risk is calculated only against production/materials; caller must exclude waste already charged by supplier.
    const riskReserve = (variableSupplier + otherMaterials) * riskRate;
    const direct = variableSupplier + otherMaterials + packaging + outbound + machineEnergy + outsideServices + riskReserve;
    if (direct + laborTotal.total <= 0) throw Error('ต้นทุนงานรวมต้องมากกว่า 0');
    const allocatedOverhead = workingHours * oh.perHour;
    const commonCost = direct + laborTotal.total + allocatedOverhead;
    const scenarios = {};
    for (const buyer of ['b2c', 'b2b']) {
      const margin = ratio(profile[buyer + '_margin'], 'Target Margin ' + buyer.toUpperCase());
      const paymentRate = ratio(profile[buyer + '_payment_fee'], 'Payment Fee ' + buyer.toUpperCase());
      const admin = buyer === 'b2b' ? amount(profile.b2b_admin_fee || 0, 'ค่าดำเนินการ B2B') : 0;
      const financeAnnual = buyer === 'b2b' ? ratio(profile.b2b_financing_rate || 0, 'ต้นทุนเงินทุนต่อปี') : 0;
      const days = buyer === 'b2b' ? amount(profile.b2b_credit_days || 0, 'จำนวนวันเครดิต') : 0;
      if (days > 3650) throw Error('จำนวนวันเครดิตมากเกินไป');
      const financingRate = financeAnnual * days / 365;
      // Payment fees and financing cost are tied to selling price, so both belong in denominator.
      const denominator = 1 - margin - paymentRate - financingRate;
      if (denominator <= 0.01) throw Error('Margin + ค่าธรรมเนียม + เครดิต สูงเกินไปสำหรับ ' + buyer.toUpperCase());
      const unrounded = (commonCost + admin) / denominator;
      if (!Number.isFinite(unrounded) || unrounded > MAX) throw Error('ราคาที่คำนวณเกินขอบเขต');
      const suggested = Math.ceil(unrounded); // round UP THB so margin is never silently reduced
      const paymentFee = suggested * paymentRate;
      const financingCost = suggested * financingRate;
      const totalCost = commonCost + admin + paymentFee + financingCost;
      const netProfit = suggested - totalCost;
      const contribution = suggested - direct - laborTotal.total - admin - paymentFee - financingCost;
      scenarios[buyer] = {
        targetMargin: margin, price: suggested, margin: netProfit / suggested,
        profit: netProfit, contribution, totalCost, paymentFee, financingCost,
        overhead: allocatedOverhead, adminCost: admin,
        // withholding affects cash received, not sales price or gross margin; intentionally excluded
        outputVat: 0
      };
    }
    return {
      assumptions: 'internal-only / not approved selling rate',
      direct, labor: laborTotal, riskReserve, monthlyOverhead: oh.monthly,
      hourlyOverhead: oh.perHour, allocatedOverhead, commonCost,
      buyers: scenarios
    };
  }
  const api = { amount, ratio, overhead, labor, quote, rounded };
  root.SCWORK_COST_ENGINE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
