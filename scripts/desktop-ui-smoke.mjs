import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const packageDir = path.resolve(process.argv[2]);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-ui-'));
const origin = 'http://localhost:3190';
const secret = crypto.randomBytes(32).toString('hex'), salt = crypto.randomBytes(16).toString('hex'), password = 'desktop-test-password';
const code = crypto.createHash('sha256').update(Buffer.from(secret,'hex')).digest('hex').slice(0,10).toUpperCase();
const configPath = path.join(temporary,'config.json');
fs.writeFileSync(configPath,JSON.stringify({web_server:{bind_address:'127.0.0.1:8099',url_path_prefix:`/desktop/${code}`,first_login_create_admin:true,first_login_assign_global_hosts:true},data_storage:{type:'json',path:path.join(temporary,'storage.json'),session_expiration_check_interval:{secs:60,nanos:0}}}));
const engine = spawn(path.join(packageDir,'web-server'),['--config-path',configPath],{cwd:packageDir,stdio:'pipe'});
const server = spawn(process.execPath,['server.js'],{cwd,env:{...process.env,PORT:'3190',SPOWER_PASSWORD:'test-only-password',DATA_DIR:path.join(temporary,'data'),GEMINI_API_KEY:'',NVIDIA_API_KEY:'',OPENROUTER_API_KEY:'',OPENAI_API_KEY:''},stdio:'pipe'});
let browser, host;
try {
  for(let i=0;i<100;i++){try{if((await fetch(origin+'/health')).ok && (await fetch(`http://127.0.0.1:8099/desktop/${code}/`)).ok)break}catch{}await new Promise(r=>setTimeout(r,100));}
  browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  const page = await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error' && /Content Security Policy|Refused to/.test(m.text()))errors.push(m.text());});
  await page.goto(origin); await page.keyboard.type('yyyyy'); await page.getByPlaceholder('Password',{exact:true}).fill('test-only-password'); await page.getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('button',{name:'Remote Access',exact:true}).click();
  await page.getByText('Connect a new Windows PC',{exact:true}).click();
  await page.getByRole('button',{name:'Create pairing code',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[aria-label="Pairing code"]').value.length>20);
  const enrollment=await page.getByLabel('Pairing code',{exact:true}).inputValue();
  host=spawn('python3',['scripts/bridge-smoke-runner.py'],{cwd,stdio:'pipe'});
  const registered = new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Host registration timeout')),10000);host.stdout.on('data',data=>{if(data.toString().includes('REGISTERED')){clearTimeout(timer);resolve();}});host.on('exit',code=>{clearTimeout(timer);reject(Error('Host exited '+code));});});
  host.stdin.write(JSON.stringify({portal:origin.replace('http:','https:'),code,secret,salt,passwordHash:crypto.scryptSync(password,Buffer.from(salt,'hex'),32).toString('hex'),enrollment})+'\n');
  await registered;
  await page.getByLabel('Device ID',{exact:true}).fill(code);await page.getByLabel('Device password',{exact:true}).fill(password);
  const authenticated=page.waitForResponse(r=>r.url().includes(`/desktop/${code}/api/authenticate`) && r.status()===200);
  await page.getByRole('button',{name:'Connect',exact:true}).click();
  await authenticated;
  const frame=page.frameLocator('iframe[title="Remote desktop"]');
  await frame.locator('.host-add').waitFor();
  await frame.locator('.open-settings').click();
  await frame.locator('body').getByText('Bitrate', {exact: false}).first().waitFor();
  assert.equal(await page.getByLabel('Device password',{exact:true}).inputValue(),'');
  await page.waitForTimeout(800);
  console.log('Moonlight UI:',(await frame.locator('body').innerText()).replace(/\s+/g,' ').slice(0,260));
  assert.deepEqual(errors,[]);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const artifacts=process.env.UI_ARTIFACTS;
  if(artifacts){fs.mkdirSync(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,'remote-mobile.png'),fullPage:true});}
  await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('iframe[title="Remote desktop"]'));
  console.log('PASS: real engine through Node + Python relay, enrollment UI, authenticated iframe, CSP, password clearing, mobile layout, disconnect');
} finally {
  await browser?.close();host?.kill();engine.kill();server.kill();fs.rmSync(temporary,{recursive:true,force:true});
}
