import TextRecognition, { TextBlock } from '@react-native-ml-kit/text-recognition';

/**
 * Lê o texto de uma foto, offline, com o ML Kit do Google.
 * Ela recebe o caminho da foto (file://...) e devolve o texto encontrado.
 *
 * A limpeza do texto veio do OCR em Python da Marcelly (text_reconstruction.py):
 * - cada bloco de texto vira um parágrafo, e a voz faz uma pausa entre eles;
 * - junta palavras cortadas com hífen no fim da linha ("compu-" + "tador");
 * - corrige "0" e "1" lidos no lugar de "o" e "l" ("c0m" -> "com");
 * - arruma espaços e pontuação sem quebrar números ("3,50", "1.000", "10:30").
 */
export async function lerTexto(caminhoDaFoto: string): Promise<string> {
  const resultado = await TextRecognition.recognize(caminhoDaFoto);
  return reconstruir(resultado.blocks);
}

const MINUSCULA = 'a-zà-ÿ';

/** Organiza os blocos de cima para baixo e transforma cada um em um parágrafo. */
export function reconstruir(blocos: TextBlock[]): string {
  return [...blocos]
    .sort((a, b) => (a.frame?.top ?? 0) - (b.frame?.top ?? 0) || (a.frame?.left ?? 0) - (b.frame?.left ?? 0))
    .map((bloco) => corrigir(juntarLinhas(bloco.lines.map((linha) => linha.text))))
    .filter((paragrafo) => paragrafo.length > 0)
    .map((paragrafo) => (/[.!?:;…]$/.test(paragrafo) ? paragrafo : paragrafo + '.'))
    .join('\n');
}

/** Une as linhas de um parágrafo, juntando palavras cortadas com hífen no fim da linha. */
function juntarLinhas(linhas: string[]): string {
  let texto = '';
  for (const bruta of linhas) {
    const linha = bruta.trim();
    if (/[A-Za-zÀ-ÿ]\s*-$/.test(texto) && new RegExp(`^[${MINUSCULA}]`).test(linha)) {
      texto = texto.replace(/\s*-$/, '') + linha;
    } else {
      texto = (texto + ' ' + linha).trim();
    }
  }
  return texto;
}

/** Corrige confusões comuns do OCR e arruma os espaços e a pontuação. */
export function corrigir(texto: string): string {
  const entreLetras = (digito: string) => new RegExp(`([${MINUSCULA}])${digito}(?=[${MINUSCULA}])`, 'g');

  return texto
    .replace(entreLetras('0'), '$1o') // "c0m" -> "com"
    .replace(entreLetras('1'), '$1l') // "a1ém" -> "além"
    .replace(new RegExp(`(^|[\\s(])0(?=\\s+[${MINUSCULA}])`, 'g'), '$1o') // "0 livro" -> "o livro"
    .replace(new RegExp(`([${MINUSCULA}])_\\s+(?=[${MINUSCULA}])`, 'g'), '$1') // "mate_ mática" -> "matemática"
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1') // "fim ." -> "fim."
    .replace(/([.,!?;:])(?=[^\s\d.,!?;:)\]"'])/g, '$1 ') // "fim.Começo" -> "fim. Começo"
    .replace(/(\D)([.,!?;:])(?=\d)/g, '$1$2 ') // "item:3" -> "item: 3", mas "3,50" fica
    .trim();
}
