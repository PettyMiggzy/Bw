const { chromium } = require('playwright');
(async()=>{ let b;
 try{ b=await chromium.launch();
  const p=await b.newPage({viewport:{width:430,height:932},deviceScaleFactor:1.3});
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  await p.goto("https://www.burnchronic.xyz/game?k=chronic420",{waitUntil:'load',timeout:45000});
  await p.waitForTimeout(2000);
  const r=await p.evaluate(()=>({seedShop:document.querySelectorAll('#seeds .up').length,ups:document.querySelectorAll('#ups .up').length,seedN:document.getElementById('seedN')&&document.getElementById('seedN').textContent,plots:document.querySelectorAll('.plot').length}));
  console.log("seed packs:",r.seedShop,"| upgrades:",r.ups,"| seeds:",r.seedN,"| plots:",r.plots);
  // plant one, check seed decrements
  await p.evaluate(()=>tapPlot(0)); await p.waitForTimeout(300);
  const after=await p.evaluate(()=>document.getElementById('seedN').textContent);
  console.log("seeds after planting:",after,"(should be 4) | errors:",JSON.stringify(errs));
  await b.close();
 }catch(e){console.log("ERR:"+e.message); if(b)await b.close();}
})();
