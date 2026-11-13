// A biblioteca de Bluetooth (react-native-ble-plx) envia e recebe dados em base64.
const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function paraBase64(bytes: Uint8Array): string {
  let saida = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    saida += ALFABETO[(n >> 18) & 63] + ALFABETO[(n >> 12) & 63];
    saida += i + 1 < bytes.length ? ALFABETO[(n >> 6) & 63] : '=';
    saida += i + 2 < bytes.length ? ALFABETO[n & 63] : '=';
  }
  return saida;
}

export function deBase64(texto: string): Uint8Array {
  const limpo = texto.replace(/[^A-Za-z0-9+/]/g, '');
  const saida: number[] = [];
  for (let i = 0; i < limpo.length; i += 4) {
    const n =
      (ALFABETO.indexOf(limpo[i]) << 18) |
      (ALFABETO.indexOf(limpo[i + 1]) << 12) |
      ((i + 2 < limpo.length ? ALFABETO.indexOf(limpo[i + 2]) : 0) << 6) |
      (i + 3 < limpo.length ? ALFABETO.indexOf(limpo[i + 3]) : 0);
    saida.push((n >> 16) & 0xff);
    if (i + 2 < limpo.length) saida.push((n >> 8) & 0xff);
    if (i + 3 < limpo.length) saida.push(n & 0xff);
  }
  return new Uint8Array(saida);
}
