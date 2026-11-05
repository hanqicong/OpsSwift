#!/usr/bin/env python3
"""Build a locally signed OpsSwift macOS ARM64 directory and ZIP, without personal data."""
from pathlib import Path
import hashlib
import json
import os
import platform
import plistlib
import subprocess

ROOT = Path(__file__).resolve().parents[1]
def run(args, **kw):
    return subprocess.run(args, cwd=ROOT, check=True, **kw)

def main():
    if platform.system() != 'Darwin': raise SystemExit('macOS required for this release target')
    pkg = json.loads((ROOT / 'package.json').read_text())
    if pkg['name'] != 'opsswift': raise SystemExit('Refusing an unexpected package identity')
    # Engines must be built from pinned sources or supplied from a separately verified upstream bundle.
    source = ROOT / 'resources/bin'
    manifest = json.loads((source / 'manifest.json').read_text())
    engines = {n: e for n, e in manifest['binaries'].items() if n.startswith('darwin-arm64/')}
    if len(engines) != 4: raise SystemExit('Expected the four reviewed ARM64 engine entries')
    for name, entry in engines.items():
        if hashlib.sha256((source / name).read_bytes()).hexdigest() != entry['sha256']:
            raise SystemExit('Engine hash mismatch: ' + name)
    env = dict(os.environ)
    for key in ['APPLE_ID','APPLE_APP_SPECIFIC_PASSWORD','APPLE_TEAM_ID','CSC_LINK','CSC_KEY_PASSWORD']:
        env.pop(key, None)
    env.update({'CSC_IDENTITY_AUTO_DISCOVERY':'false','ELECTRON_BUILDER_CACHE':'/private/tmp/opsswift-builder-cache','npm_config_cache':'/private/tmp/opsmaxx-network-npm-cache'})
    run(['npm','run','build'], env=env)
    run(['npx','electron-builder','--dir','--mac','--arm64','-c.npmRebuild=false','-c.electronDist=node_modules/electron/dist'], env=env)
    app = ROOT / 'release/mac-arm64/OpsSwift.app'
    run(['node','scripts/verify-local-pty-pack.mjs',str(app.parent)])
    sign = ['codesign','--force','--sign','-','--options','runtime','--entitlements',str(ROOT/'build/entitlements.mac.plist')]
    run(sign + ['--deep',str(app)])
    bins = app / 'Contents/Resources/bin'
    p = bins / 'manifest.json'; data = json.loads(p.read_text()); data['binaries'] = {n:e for n,e in data['binaries'].items() if (bins/n).is_file()};p.write_text(json.dumps(data,indent=2)+'\n')
    run(['node','-e',"require('./scripts/after-sign.cjs').rehashManifest(process.argv[1])",str(bins)])
    run(sign + [str(app)]); run(['codesign','--verify','--strict','--deep',str(app)])
    info = plistlib.loads((app/'Contents/Info.plist').read_bytes())
    assert info['CFBundleIdentifier']=='com.lyitech.opsswift' and info['CFBundleShortVersionString']==pkg['version']
    target=ROOT/'release'/f'OpsSwift-{pkg["version"]}-mac-arm64.zip'
    run(['ditto','-c','-k','--sequesterRsrc','--keepParent',str(app),str(target)])
    report={'product':'OpsSwift','version':pkg['version'],'bundleId':info['CFBundleIdentifier'],'signature':'local ad-hoc hardened runtime, not Apple notarized','artifact':target.name,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'sizeBytes':target.stat().st_size,'personalDataIncluded':False,'engineCount':len(data['binaries'])}
    (ROOT/'release/artifact.json').write_text(json.dumps(report,indent=2)+'\n'); print(json.dumps(report))

if __name__=='__main__': main()
