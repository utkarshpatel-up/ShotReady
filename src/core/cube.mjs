// Reads a 3D LUT in the .cube format (Adobe / Resolve), the format Canon ships its LUTs in.
// The file comes from the operator, so everything is checked before it reaches the graphics card.

export function parseCube(text) {
  let size = 0, title = '';
  let min = [0, 0, 0], max = [1, 1, 1];
  const values = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (/^[-+.\d]/.test(parts[0])) {
      if (parts.length < 3) throw new Error(`A LUT line has fewer than 3 numbers: "${line.slice(0, 40)}"`);
      values.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
      continue;
    }
    const key = parts[0].toUpperCase();
    if (key === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '');
    else if (key === 'LUT_3D_SIZE') size = Number(parts[1]);
    else if (key === 'LUT_1D_SIZE') throw new Error('This is a 1D LUT. A 3D LUT is needed (a .cube file with LUT_3D_SIZE)');
    else if (key === 'DOMAIN_MIN') min = parts.slice(1, 4).map(Number);
    else if (key === 'DOMAIN_MAX') max = parts.slice(1, 4).map(Number);
    else if (key === 'LUT_3D_INPUT_RANGE') { min = [1, 1, 1].map(() => Number(parts[1])); max = [1, 1, 1].map(() => Number(parts[2])); }
  }
  if (!Number.isInteger(size) || size < 2 || size > 129) throw new Error('Not a 3D LUT: LUT_3D_SIZE (2 to 129) is missing');
  if (values.length !== size ** 3 * 3) throw new Error(`A ${size}-point LUT needs ${size ** 3} entries, the file has ${values.length / 3}`);
  if (!values.every(Number.isFinite)) throw new Error('The LUT has an entry that is not a number');
  if (![...min, ...max].every(Number.isFinite) || min.some((m, i) => !(max[i] > m))) throw new Error('The LUT\'s DOMAIN_MIN / DOMAIN_MAX are not usable');
  return { size, title, min, max, data: Float32Array.from(values) };
}

// Canon names its LUT files with the input and output range, for example _FF_ (full in, full out)
// or _LL_ (legal in, legal out). Anything else starts as full and full; Settings can change it.
export function rangesFromName(name) {
  const m = /(?:^|[_\-\s.])([FL])([FL])(?=[_\-\s.]|$)/.exec(name.replace(/\.cube$/i, ''));
  const word = (l) => (l === 'L' ? 'legal' : 'full');
  return m ? { input: word(m[1]), output: word(m[2]) } : { input: 'full', output: 'full' };
}
