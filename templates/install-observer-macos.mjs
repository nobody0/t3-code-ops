import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
if(process.platform!=='darwin') throw Error('Run on the verified Mac as Bob');
const config=path.resolve(process.argv[2]);
if(!fs.existsSync(config)) throw Error('Observer config missing');
const ops=path.resolve(import.meta.dirname,'..');
const escape=x=>x.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const label='com.nobody0.t3-maintenance-observer';
const file=path.join(os.homedir(),'Library/LaunchAgents',label+'.plist');
const argv=[process.execPath,path.join(ops,'scripts/observe.mjs'),config];
const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${argv.map(x=>`<string>${escape(x)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>StartInterval</key><integer>300</integer><key>StandardOutPath</key><string>${escape(path.join(path.dirname(config),'observer.log'))}</string><key>StandardErrorPath</key><string>${escape(path.join(path.dirname(config),'observer-error.log'))}</string></dict></plist>`;
const domain=`gui/${process.getuid()}`;
let loaded=false;try{execFileSync('launchctl',['print',`${domain}/${label}`],{stdio:'ignore'});loaded=true;}catch{}
if(loaded) execFileSync('launchctl',['bootout',`${domain}/${label}`]);
fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,plist,{mode:0o600});
execFileSync('launchctl',['bootstrap',domain,file]);
