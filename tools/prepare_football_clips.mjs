import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';

const exe = resolve('node_modules/fbx2gltf/bin/Windows_NT/FBX2glTF.exe');
const sourceDir = 'mocap_source/Mocap_Pack_05_Soccer/mocap/Rokoko_Default';
const convertedDir = 'mocap_source/converted';
const clipDir = 'assets/football/clips';
mkdirSync(convertedDir, { recursive: true });
mkdirSync(clipDir, { recursive: true });

const files = readdirSync(sourceDir).filter((f) => extname(f).toLowerCase() === '.fbx').sort();
const manifest = JSON.parse(readFileSync('assets/football/manifest.json', 'utf8'));
const wanted = new Set(manifest.clips.map((entry) => entry.file));
const io = new NodeIO();
const report = [];

for (const file of files) {
  const slug = basename(file, '.fbx').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const raw = join(convertedDir, `${slug}.glb`);
  const out = join(clipDir, `${slug}.glb`);
  if (!existsSync(raw)) {
    execFileSync(exe, ['-i', join(sourceDir, file), '-o', join(convertedDir, slug), '-b', '--anim-framerate', 'bake30'], { stdio: 'pipe' });
  }
  const doc = await io.read(raw);
  const root = doc.getRoot();
  for (const node of root.listNodes()) node.setMesh(null);
  for (const mesh of root.listMeshes()) mesh.dispose();
  for (const skin of root.listSkins()) skin.dispose();
  for (const material of root.listMaterials()) material.dispose();
  for (const texture of root.listTextures()) texture.dispose();
  await doc.transform(prune({ keepAttributes: false, keepLeaves: true, keepSolidTextures: false }));
  await io.write(out, doc);
  const rawSize = statSync(raw).size;
  if (!wanted.has(`${slug}.glb`)) {
    if (existsSync(out)) unlinkSync(out);
    console.log(`${slug.padEnd(32)}  (not in runtime manifest)`);
    continue;
  }
  const outSize = statSync(out).size;
  report.push({ file, slug, rawKB: Math.round(rawSize / 1024), clipKB: Math.round(outSize / 1024) });
  console.log(`${slug.padEnd(32)} ${String(Math.round(outSize / 1024)).padStart(6)} KB  (from ${Math.round(rawSize / 1024)} KB)`);
}

console.log(JSON.stringify(report, null, 2));
