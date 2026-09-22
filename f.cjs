const fs=require("fs");const p="app/domain/bankpayment/guaranteeCancellationEmail.test.ts";
let s=fs.readFileSync(p,"utf8");
const o=`  it("carries no money figure and no internal pricing vocabulary", () => {
    const { subject, text } = buildGuaranteeCancellationEmail({
      bankPaymentOrderId: "order-1",
      customerFirstName: "Ada",
    });`;
const x=`  it("carries no money figure and no internal pricing vocabulary", () => {
    // A digit-free order reference, so the digit assertion below measures the
    // COPY rather than whatever id the fixture happened to use.
    const { subject, text } = buildGuaranteeCancellationEmail({
      bankPaymentOrderId: "ORDER-REF",
      customerFirstName: "Ada",
    });`;
if(!s.includes(o)) throw new Error("nf");
fs.writeFileSync(p,s.replace(o,x));console.log("ok");
