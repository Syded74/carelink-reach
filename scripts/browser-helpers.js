'use strict';
const fs=require('node:fs');
const path=require('node:path');
const puppeteer=require('puppeteer-core');
const {stateDir}=require('./client');
// Accounts from npm run setup-accounts share CARELINK_ACCOUNT_PASSWORD; older seeded accounts keep their private file.
const credentialsFile=path.join(stateDir,'demo-credentials.json');
const credentials=new Proxy(fs.existsSync(credentialsFile)?JSON.parse(fs.readFileSync(credentialsFile)):{},{get:(saved,username)=>saved[username]||{password:process.env.CARELINK_ACCOUNT_PASSWORD}});
async function launch(){return puppeteer.launch({executablePath:process.env.CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-sandbox']});}
async function login(browser,username){
 const context=await browser.createIncognitoBrowserContext();
 const page=await context.newPage();await page.setViewport({width:1365,height:950});
 page.setDefaultTimeout(60000);
 await page.goto('http://localhost:5988/',{waitUntil:'networkidle2'});
 await page.type('#user',username);await page.type('#password',credentials[username].password);
 await Promise.all([page.waitForNavigation({waitUntil:'networkidle2',timeout:60000}),page.click('#login')]);
 try { await page.waitForFunction(()=>!!document.querySelector('.app-root.bootstrapped'),{timeout:45000}); } catch(e) { console.log('BOOTSTRAP', username, await page.evaluate(()=>document.body.innerText)); await page.screenshot({path:path.join(evidence,username+'-bootstrap.png')}); throw e; }
 return {context,page};
}
const text=page=>page.evaluate(()=>document.body.innerText);
const evidence=path.join(__dirname,'../evidence');
// Contacts a regression flow creates are marked so service counts and forecasts skip them (lib/test-records.js).
async function markTestRecords(couch,ids){
 const {TEST_ORIGIN}=require('../lib/test-records');
 const rows=(await couch('/medic/_all_docs?include_docs=true',{method:'POST',body:JSON.stringify({keys:ids})})).rows;
 const docs=rows.filter(r=>r.doc).map(r=>({...r.doc,record_origin:TEST_ORIGIN}));
 const results=await couch('/medic/_bulk_docs',{method:'POST',body:JSON.stringify({docs})});
 if(results.some(r=>r.error)){throw Error('Could not mark test records: '+JSON.stringify(results.filter(r=>r.error)));}
}
/*
  Test plans approved by earlier runs keep the CHO's days booked. Release them the normal way: the CHO
  records each leftover test-plan day as not done (append-only, with a reason). Real plans are never touched.
  Returns the CHO's days still booked by unrecorded outreach days.
*/
async function releaseTestDays(couch,choUser,choId,password){
 const docs=(await couch('/medic/_all_docs?include_docs=true')).rows.map(r=>r.doc).filter(Boolean);
 const testPlans=new Set(docs.filter(d=>d.form==='carelink_oi_proposal'&&d.fields&&d.fields.includes_test_records).map(d=>d._id));
 const recorded=new Set(docs.filter(d=>d.form==='carelink_oi_outreach_day').map(d=>d.fields.assignment_id));
 const leftover=docs.filter(d=>d.form==='carelink_oi_assignment'&&testPlans.has(d.fields.proposal_id)&&!recorded.has(d._id));
 if(leftover.length){
  const body=JSON.stringify({docs:leftover.map(a=>({_id:`release-${a._id}`,type:'data_record',form:'carelink_oi_outreach_day',content_type:'xml',reported_date:Date.now(),contact:{_id:choId},
   fields:{patient_id:a.fields.patient_id,assignment_id:a._id,proposal_id:a.fields.proposal_id,outcome:'not_done',reason:'Test run finished; day released.'}}))});
  const r=await (await fetch('http://localhost:5988/medic/_bulk_docs',{method:'POST',body,headers:{'Content-Type':'application/json',Authorization:'Basic '+Buffer.from(`${choUser}:${password}`).toString('base64')}})).json();
  if(r.some(x=>!x.ok&&x.error!=='conflict')){throw Error('Could not release test days: '+JSON.stringify(r.filter(x=>!x.ok)));}
  leftover.forEach(a=>recorded.add(a._id));
 }
 return new Set(docs.filter(d=>d.form==='carelink_oi_assignment'&&d.fields.worker_id===choId&&!recorded.has(d._id)).map(d=>d.fields.date));
}
// Saves the open Add household form. If CHT flags a similar existing household and the name is not identical,
// tick "Confirm this contact is not a duplicate entry" and save again, as a volunteer would for a different household.
async function submitHousehold(page,name){
 await page.click('.form-footer .submit');
 await page.waitForFunction(()=>!document.querySelector('.enketo form')||document.body.innerText.includes('Possible duplicate contacts found'),{timeout:30000});
 if(!await page.$('.enketo form')){return false;}
 const similar=await page.evaluate(()=>document.querySelector('mm-duplicate-contacts, .duplicate-contacts')?.innerText||document.body.innerText);
 if(similar.includes(`Name: ${name}\n`)||similar.includes(`Name: ${name}`+'\n')){throw Error(`A household named "${name}" already exists.`);}
 await page.click('input#check');
 await page.click('.form-footer .submit');
 await page.waitForFunction(()=>!document.querySelector('.enketo form'),{timeout:30000});
 return true;
}
module.exports={launch,login,text,evidence,markTestRecords,releaseTestDays,submitHousehold};
