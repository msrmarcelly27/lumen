import { Directory, File, Paths } from 'expo-file-system';
import { ConexaoOculos } from './conexao';
import { ClienteFtp } from './ftp';
import { Comandos, InfoWifi } from './protocolo';
import { entrarNaRedeDoOculos, ipDoCelular, sairDaRedeDoOculos } from './wifi';

function pastaDeFotos(): Directory {
  const pasta = new Directory(Paths.document, 'fotos');
  if (!pasta.exists) pasta.create();
  return pasta;
}

async function ligarWifiComRepeticao(conexao: ConexaoOculos): Promise<InfoWifi> {
  try {
    return await conexao.ligarWifi();
  } catch (erro) {
    // Igual ao app oficial: se o óculos recusar, se apresenta de novo e tenta mais uma vez.
    if (String((erro as Error).message) !== 'WIFI_RECUSADO') throw erro;
    await conexao.enviar(Comandos.handshake());
    await conexao.enviar(Comandos.heartbeat());
    return conexao.ligarWifi();
  }
}

/**
 * Baixa a foto mais nova do óculos e devolve o arquivo salvo no celular.
 * Passos: liga o Wi-Fi do óculos -> entra na rede dele -> baixa por FTP -> sai da rede -> desliga o Wi-Fi.
 */
export async function baixarFotoNova(
  conexao: ConexaoOculos,
  aoAvancar: (etapa: string) => void,
): Promise<File | null> {
  aoAvancar('Ligando o Wi-Fi do óculos…');
  const info = await ligarWifiComRepeticao(conexao);

  try {
    aoAvancar('Conectando na rede do óculos…');
    await entrarNaRedeDoOculos(info.ssid, info.senha);

    if (conexao.estado === 'conectado') {
      conexao.enviar(Comandos.iniciarTransferencia()).catch(() => {});
    }

    aoAvancar('Baixando a foto…');
    const ftp = new ClienteFtp(info.ip, info.porta, ipDoCelular);
    await ftp.entrar(info.usuario, info.senhaFtp);
    try {
      const fotos = (await ftp.listar()).filter((n) => /\.jpe?g$/i.test(n)).sort();
      const nome = fotos[fotos.length - 1]; // o nome é a data/hora, então a última é a mais nova
      if (!nome) return null;
      const arquivo = new File(pastaDeFotos(), nome);
      if (!arquivo.exists) {
        const bytes = await ftp.baixar(nome);
        arquivo.create();
        arquivo.write(bytes);
      }
      return arquivo;
    } finally {
      await ftp.sair();
    }
  } finally {
    await sairDaRedeDoOculos();
    // O Bluetooth pode ter caído quando o Wi-Fi ligou; espera ele voltar para desligar o Wi-Fi do óculos.
    if (await conexao.aguardarConexao(20_000)) {
      conexao.enviar(Comandos.desligarWifi()).catch(() => {});
    }
  }
}

/** Traduz os erros do ciclo para frases que fazem sentido para quem usa o app. */
export function mensagemDoCiclo(erro: unknown): string {
  const texto = String((erro as Error)?.message ?? erro);
  if (texto.includes('WIFI_RECUSADO')) return 'O óculos não ligou o Wi-Fi. Reinicie o óculos e tente de novo.';
  if (texto.includes('WIFI_SEM_RESPOSTA')) return 'O óculos não respondeu. Tire a foto de novo.';
  if (texto.includes('PERMISSAO_LOCALIZACAO')) return 'Permita o acesso à localização para o app usar o Wi-Fi do óculos.';
  if (texto.startsWith('FTP')) return 'Não consegui baixar a foto do óculos.';
  return 'Não consegui me conectar ao Wi-Fi do óculos.';
}
