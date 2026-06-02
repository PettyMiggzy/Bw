const fs=require("fs");
const KEY="V7SXWDKHZAQJ6NU1WR8S8D4RR6JY4DGXS9";
const CHAIN=143;
const BASE="https://api.etherscan.io/v2/api";
const stdInput=fs.readFileSync(__dirname+"/chronic-std-input.json","utf8");
const COMPILER="v0.8.26+commit.8a97fa7a";
const FEE="e7a31fd91a6f2ab0c73db3b7d0954a6a3acc7ab5";
const ctorArgs="000000000000000000000000"+FEE; // address _feeRecipient
const targets=[
  {addr:"0x5F4EA86d5679c04Ebf7a548f8E0Ac11c8dBaac6A", name:"ChronicMint.sol:ChronicMint"},
  {addr:"0x4D986e1A3CAf6cc29d42953c2bD3B81741639a30", name:"ChronicMarket.sol:ChronicMarket"},
];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function submit(t){
  const body=new URLSearchParams({
    chainid:String(CHAIN), apikey:KEY, module:"contract", action:"verifysourcecode",
    codeformat:"solidity-standard-json-input", sourceCode:stdInput,
    contractaddress:t.addr, contractname:t.name, compilerversion:COMPILER,
    constructorArguements:ctorArgs
  });
  const r=await fetch(BASE+"?chainid="+CHAIN,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
  const j=await r.json();
  console.log(`submit ${t.name}: status=${j.status} result=${j.result}`);
  return j.status==="1"?j.result:null; // guid
}
async function check(guid,name){
  for(let i=0;i<12;i++){
    await sleep(4000);
    const u=`${BASE}?chainid=${CHAIN}&module=contract&action=checkverifystatus&guid=${guid}&apikey=${KEY}`;
    const j=await (await fetch(u)).json();
    console.log(`  ${name} poll ${i+1}: ${j.result}`);
    if(j.result&&j.result!=="Pending in queue") return j.result;
  }
  return "timeout";
}
(async()=>{
  for(const t of targets){
    const guid=await submit(t);
    if(guid) await check(guid,t.name);
    await sleep(1500);
  }
})();
