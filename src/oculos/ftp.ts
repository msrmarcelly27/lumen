import TcpSocket from 'react-native-tcp-socket';

/**
 * Cliente FTP bem simples, só com o que o óculos precisa:
 * entrar, listar os arquivos e baixar um arquivo.
 * Tenta o modo passivo (PASV) e, se o óculos não aceitar, usa o modo ativo (PORT).
 */

type Socket = ReturnType<typeof TcpSocket.createConnection>;
type Resposta = { codigo: number; texto: string };

const TEMPO_LIMITE = 15_000;

function bytesParaTexto(dados: Uint8Array | string): string {
  if (typeof dados === 'string') return dados;
  let texto = '';
  for (const b of dados) texto += String.fromCharCode(b);
  return texto;
}

function juntar(pedacos: Uint8Array[]): Uint8Array {
  const total = pedacos.reduce((soma, p) => soma + p.length, 0);
  const saida = new Uint8Array(total);
  let pos = 0;
  for (const p of pedacos) {
    saida.set(p, pos);
    pos += p.length;
  }
  return saida;
}

function comLimite<T>(promessa: Promise<T>, ms: number, mensagem: string): Promise<T> {
  return new Promise<T>((resolve, rejeitar) => {
    const timer = setTimeout(() => rejeitar(new Error(mensagem)), ms);
    promessa.then(
      (valor) => {
        clearTimeout(timer);
        resolve(valor);
      },
      (erro) => {
        clearTimeout(timer);
        rejeitar(erro);
      },
    );
  });
}

function abrirSocket(host: string, porta: number): Promise<Socket> {
  return new Promise((resolve, rejeitar) => {
    const socket = TcpSocket.createConnection(
      { host, port: porta, interface: 'wifi', connectTimeout: 10_000 },
      () => resolve(socket),
    );
    socket.once('error', rejeitar);
  });
}

/** Junta tudo que chegar num socket de dados até ele fechar. */
function coletar(socket: Socket): Promise<Uint8Array> {
  return new Promise((resolve, rejeitar) => {
    const pedacos: Uint8Array[] = [];
    socket.on('data', (dados) =>
      pedacos.push(typeof dados === 'string' ? Uint8Array.from(dados, (c) => c.charCodeAt(0)) : dados),
    );
    socket.on('error', rejeitar);
    socket.on('close', () => resolve(juntar(pedacos)));
  });
}

type CanalDados = { bytes: Promise<Uint8Array>; fechar: () => void };

export class ClienteFtp {
  private controle: Socket | null = null;
  private parcial = '';
  private linhas: string[] = [];
  private prontas: Resposta[] = [];
  private esperando: ((r: Resposta) => void)[] = [];
  private usarPassivo = true;

  constructor(
    private host: string,
    private porta: number,
    private ipDoCelular?: () => Promise<string>, // usado só no modo ativo
  ) {}

  async entrar(usuario: string, senha: string): Promise<void> {
    this.controle = await abrirSocket(this.host, this.porta);
    this.controle.on('data', (dados) => this.receber(bytesParaTexto(dados)));
    await this.esperarCodigo([220]);
    const r = await this.comando(`USER ${usuario}`, [230, 331]);
    if (r.codigo === 331) await this.comando(`PASS ${senha}`, [230]);
    await this.comando('TYPE I', [200]);
  }

  async listar(): Promise<string[]> {
    const bytes = await this.transferir('NLST');
    return bytesParaTexto(bytes)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  baixar(nome: string): Promise<Uint8Array> {
    return this.transferir(`RETR ${nome}`);
  }

  async sair(): Promise<void> {
    try {
      this.controle?.write('QUIT\r\n');
    } catch {}
    this.controle?.destroy();
    this.controle = null;
  }

  // ---------- interno ----------

  private async transferir(comando: string): Promise<Uint8Array> {
    const canal = await this.abrirCanal();
    try {
      await this.comando(comando, [125, 150]);
      const bytes = await comLimite(canal.bytes, 60_000, 'FTP: transferência demorou demais');
      await this.esperarCodigo([226, 250]);
      return bytes;
    } finally {
      canal.fechar();
    }
  }

  private async abrirCanal(): Promise<CanalDados> {
    if (this.usarPassivo) {
      const r = await this.comando('PASV', [227, 500, 502, 504]).catch(() => null);
      const m = r && r.codigo === 227 && /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(r.texto);
      if (m) {
        let ip = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
        if (ip === '0.0.0.0') ip = this.host; // alguns servidores pequenos respondem assim
        const socket = await abrirSocket(ip, Number(m[5]) * 256 + Number(m[6]));
        return { bytes: coletar(socket), fechar: () => socket.destroy() };
      }
      this.usarPassivo = false; // o óculos não aceitou PASV: daqui pra frente, modo ativo
    }
    return this.abrirCanalAtivo();
  }

  private async abrirCanalAtivo(): Promise<CanalDados> {
    if (!this.ipDoCelular) throw new Error('FTP: modo ativo sem IP do celular');
    const ip = await this.ipDoCelular();
    const porta = 20_000 + Math.floor(Math.random() * 20_000);
    let aoConectar: (s: Socket) => void = () => {};
    const conexao = new Promise<Socket>((resolve) => (aoConectar = resolve));
    const servidor = TcpSocket.createServer((socket) => aoConectar(socket as Socket));
    await new Promise<void>((resolve) => servidor.listen({ port: porta, host: '0.0.0.0' }, () => resolve()));
    await this.comando(`PORT ${ip.split('.').join(',')},${porta >> 8},${porta & 0xff}`, [200]);
    return {
      bytes: conexao.then(coletar),
      fechar: () => servidor.close(),
    };
  }

  private async comando(texto: string, aceitos: number[]): Promise<Resposta> {
    if (!this.controle) throw new Error('FTP: sem conexão');
    this.controle.write(`${texto}\r\n`);
    return this.esperarCodigo(aceitos, texto.split(' ')[0]);
  }

  private async esperarCodigo(aceitos: number[], nome = 'FTP'): Promise<Resposta> {
    const r = await comLimite(this.proximaResposta(), TEMPO_LIMITE, `FTP: ${nome} sem resposta`);
    if (!aceitos.includes(r.codigo)) throw new Error(`FTP: ${nome} recusado (${r.codigo} ${r.texto})`);
    return r;
  }

  private proximaResposta(): Promise<Resposta> {
    const pronta = this.prontas.shift();
    if (pronta) return Promise.resolve(pronta);
    return new Promise((resolve) => this.esperando.push(resolve));
  }

  /** Separa o texto do canal de controle em respostas (inclusive as de várias linhas: "220-..." até "220 ..."). */
  private receber(texto: string) {
    const partes = (this.parcial + texto).split('\n');
    this.parcial = partes.pop() ?? '';
    this.linhas.push(...partes.map((l) => l.replace(/\r$/, '')));

    while (this.linhas.length) {
      const m = /^(\d{3})([ -])(.*)$/.exec(this.linhas[0]);
      if (!m) {
        this.linhas.shift();
        continue;
      }
      let fim = 0;
      if (m[2] === '-') {
        fim = this.linhas.findIndex((l, i) => i > 0 && l.startsWith(`${m[1]} `));
        if (fim < 0) return; // resposta de várias linhas ainda incompleta
      }
      const bloco = this.linhas.splice(0, fim + 1);
      const resposta = { codigo: Number(m[1]), texto: bloco.join('\n') };
      const espera = this.esperando.shift();
      if (espera) espera(resposta);
      else this.prontas.push(resposta);
    }
  }
}
