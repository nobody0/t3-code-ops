import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
if(process.platform!=='darwin') throw Error('Run on the Mac as the GUI operator');
const [profile,koRoot,bun]=process.argv.slice(2).map(x=>path.resolve(x));
const url='http://localhost:4321/e/t3-maintenance';
const cache=path.join(koRoot,'.cache/t3-maintenance');fs.mkdirSync(cache,{recursive:true});
const file=path.join(profile,'user.js');
let existing=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
if(existing) fs.copyFileSync(file,path.join(cache,`firefox-user-${Date.now()}.js`));
const prefs=fs.readFileSync(path.join(profile,'prefs.js'),'utf8');
const match=prefs.match(/user_pref\("browser.startup.homepage",\s*("(?:[^"\\]|\\.)*")\);/);
const pages=[...new Set([...(match?JSON.parse(match[1]):'about:home').split('|'),url])];
existing=existing.replace(/\n?\/\/ BEGIN T3 maintenance homepage[\s\S]*?\/\/ END T3 maintenance homepage\n?/g,'');
fs.writeFileSync(file,existing.trimEnd()+`\n// BEGIN T3 maintenance homepage\nuser_pref("browser.startup.homepage", ${JSON.stringify(pages.join('|'))});\n// END T3 maintenance homepage\n`);
const launch=path.join(cache,'open-reminder.sh');
const quote=x=>"'"+x.replaceAll("'","'\\''")+"'";
fs.writeFileSync(launch,`#!/bin/sh\nif ! /usr/bin/curl -fsS http://localhost:4321/api/health >/dev/null 2>&1; then\n  cd ${quote(koRoot)} || exit 1\n  /usr/bin/nohup ${quote(bun)} dev >>${quote(path.join(cache,'ko-bootstrap.log'))} 2>&1 </dev/null &\n  n=0\n  until /usr/bin/curl -fsS http://localhost:4321/api/health >/dev/null 2>&1; do\n    n=$((n+1)); [ "$n" -ge 15 ] && break; sleep 2\n  done\nfi\n/usr/bin/open -a Firefox ${quote(url)}\n`,{mode:0o700});
const escape=x=>x.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const label='com.nobody0.t3-maintenance-startpage',domain=`gui/${process.getuid()}`;
const plist=path.join(os.homedir(),'Library/LaunchAgents',label+'.plist');
const content=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>${escape(launch)}</string></array><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${escape(path.join(cache,'startpage.log'))}</string><key>StandardErrorPath</key><string>${escape(path.join(cache,'startpage-error.log'))}</string></dict></plist>`;
let loaded=false;try{execFileSync('launchctl',['print',`${domain}/${label}`],{stdio:'ignore'});loaded=true;}catch{}
if(loaded)execFileSync('launchctl',['bootout',`${domain}/${label}`]);
fs.writeFileSync(plist,content,{mode:0o600});
// Do not bootstrap now: RunAtLoad opens the user's browser. launchd loads this
// LaunchAgent at the next GUI login; existing browser/session state is untouched.
console.log('Homepage and next-login reminder configured; session restore unchanged.');
