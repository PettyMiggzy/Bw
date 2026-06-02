const fs=require("fs");
const {ethers}=require("ethers");
const RPC="https://rpc.monad.xyz", CHAIN_ID=143n;
const FEE_RECIPIENT="0xe7a31fd91a6f2ab0c73db3b7d0954a6a3acc7ab5";        // Chronic dev (fees)
const NEW_OWNER="0xB9d4B73bE18914c6d64Bee65a806648370be467f";            // treasury (admin)
const key=fs.readFileSync("/home/claude/.chronic-deployer-key","utf8").trim();
(async()=>{
  const art=JSON.parse(fs.readFileSync(__dirname+"/artifacts.json","utf8"));
  const provider=new ethers.JsonRpcProvider(RPC);
  const net=await provider.getNetwork();
  if(net.chainId!==CHAIN_ID) throw new Error("wrong chain "+net.chainId);
  const wallet=new ethers.Wallet(key,provider);
  console.log("Deployer:",wallet.address,"| bal",ethers.formatEther(await provider.getBalance(wallet.address)),"MON");
  async function dep(a,label){const f=new ethers.ContractFactory(a.abi,a.bytecode,wallet);console.log("Deploying",label,"...");const c=await f.deploy(FEE_RECIPIENT);await c.waitForDeployment();const addr=await c.getAddress();console.log("  ",label,"=",addr);return {addr,abi:a.abi};}
  const mint=await dep(art.ChronicMint,"ChronicMint");
  const market=await dep(art.ChronicMarket,"ChronicMarket");
  // transfer ownership to treasury
  for(const [label,d] of [["ChronicMint",mint],["ChronicMarket",market]]){
    const c=new ethers.Contract(d.addr,d.abi,wallet);
    console.log("transferOwnership("+NEW_OWNER+") on",label,"...");
    const tx=await c.transferOwnership(NEW_OWNER); await tx.wait();
  }
  // verify
  console.log("\n=== VERIFY ===");
  for(const [label,d] of [["ChronicMint",mint],["ChronicMarket",market]]){
    const c=new ethers.Contract(d.addr,d.abi,provider);
    const owner=await c.owner(); const fr=await c.feeRecipient();
    const code=await provider.getCode(d.addr);
    console.log(label, d.addr, "| owner="+owner, "| feeRecipient="+fr, "| hasCode="+(code&&code!=="0x"));
  }
  console.log("\nRESULT="+JSON.stringify({ChronicMint:mint.addr,ChronicMarket:market.addr}));
})().catch(e=>{console.error("FAILED:",e.message||e);process.exit(1);});
