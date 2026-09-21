const fs=require("fs");const p="livegate.ts";let s=fs.readFileSync(p,"utf8");let n=0;
const sub=(o,x)=>{if(!s.includes(o))throw new Error("NOT FOUND "+o.slice(0,70));s=s.replace(o,x);n++;};

sub(`let pass = 0;`,
`/**
 * Assigned as the FIRST thing main() does, so teardown can reach Shopify even
 * when main aborts. Set after the fact, it would be null on exactly the runs
 * that leave the most litter behind.
 */
let gql: ((q: string, v: Record<string, unknown>) => Promise<any>) | null = null;

let pass = 0;`);

sub(`  const gql = async (q: string, variables: Record<string, unknown>) => {`,
`  gql = async (q: string, variables: Record<string, unknown>) => {`);

sub(`  console.log(\`\n=== RESULT: \${pass} passed, \${fail} failed ===\`);
  return { gql };
}`,
`  console.log(\`\n=== RESULT: \${pass} passed, \${fail} failed ===\`);
}`);

sub(`async function cleanup(gql: ((q: string, v: Record<string, unknown>) => Promise<any>) | null) {`,
`async function cleanup() {`);

sub(`let gqlRef: any = null;
main()
  .then((r) => {
    gqlRef = r.gql;
  })
  .catch((e) => {`,
`main()
  .catch((e) => {`);

sub(`    await cleanup(gqlRef).catch((e) => console.error("cleanup error:", e));`,
`    await cleanup().catch((e) => console.error("cleanup error:", e));`);

fs.writeFileSync(p,s);console.log("edits:",n);
