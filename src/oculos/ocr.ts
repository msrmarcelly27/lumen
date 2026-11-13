import TextRecognition from '@react-native-ml-kit/text-recognition';

/**
 * Lê o texto de uma foto, offline, com o ML Kit do Google.
 * Para trocar pelo OCR do colega, basta mudar o que esta função faz:
 * ela recebe o caminho da foto (file://...) e devolve o texto encontrado.
 */
export async function lerTexto(caminhoDaFoto: string): Promise<string> {
  const resultado = await TextRecognition.recognize(caminhoDaFoto);
  return resultado.text.replace(/\s+/g, ' ').trim();
}
