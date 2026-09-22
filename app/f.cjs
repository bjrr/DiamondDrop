const fs=require("fs");const p="app/domain/bankpayment/guaranteeCancellationEmail.test.ts";
let s=fs.readFileSync(p,"utf8");
const o=`      bankPaymentOrderId: "order-1",
      customerFirstName: "Ada",
    });
    const whole = \`\${subject}\n\${text}\`;`;
const x=`      // A digit-free order reference, so the digit assertion below measures
      // the COPY rather than whatever id the fixture happened to use.
      bankPaymentOrderId: "ORDER-REF",
      customerFirstName: "Ada",
    });
    const whole = \`\${subject}\n\${text}\`;`;
if(!s.includes(o)) throw new Error("nf");
fs.writeFileSync(p,s.replace(o,x));console.log("ok");
