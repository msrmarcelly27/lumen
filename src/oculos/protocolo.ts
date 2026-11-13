/**
 * Protocolo do óculos AIMB-S1
 * Descoberto a partir do log Bluetooth (HCI) do app oficial.
 *
 * Formato de cada pacote:
 *   ED | 40 (pedido/evento) ou 60 (resposta) | seq | CRC | tamanho (2 bytes) | payload
 * O payload começa com grupo + comando (ex.: 10 03 = bateria).
 */

export const ENDERECO_OCULOS = 'C8:47:8C:16:31:DF';
export const UUID_SERVICO = '0000fa00-0000-1000-8000-00805f9b34fb';
export const UUID_ESCRITA = '0000ea02-0000-1000-8000-00805f9b34fb'; // app -> óculos
export const UUID_NOTIFICACAO = '0000ea01-0000-1000-8000-00805f9b34fb'; // óculos -> app

export const FTP = { ip: '192.168.10.1', porta: 21, usuario: 'bk7258', senha: '123456' };
export const PREFIXO_REDE = 'GE13'; // senha do Wi-Fi = nome da rede sem o "GE13"

const APP_ID = '1dca87de2242af0b'; // ID que o app oficial manda no handshake

// ---------- utilitários ----------

function ascii(texto: string): number[] {
  return Array.from(texto, (c) => c.charCodeAt(0) & 0xff);
}

function deAscii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

export function paraHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join('-');
}

/** CRC-8 do óculos: poly 0x1D refletido (0xB8), init 0xFF, calculado só sobre o payload. */
export function crc8(dados: Uint8Array): number {
  let c = 0xff;
  for (const b of dados) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xb8 : c >>> 1;
  }
  return c;
}

// ---------- montagem de pacotes ----------

export class Empacotador {
  private seq = 0;

  montar(payload: Uint8Array): Uint8Array {
    const pacote = new Uint8Array(6 + payload.length);
    pacote.set([0xed, 0x40, this.seq, crc8(payload), payload.length >> 8, payload.length & 0xff]);
    pacote.set(payload, 6);
    this.seq = (this.seq + 1) & 0xff;
    return pacote;
  }
}

export const Comandos = {
  handshake: () =>
    new Uint8Array([0x10, 0x01, 0x01, APP_ID.length, ...ascii(APP_ID), 0x02, ...ascii('en')]),

  /** Sincroniza o relógio do óculos com o do celular (e o fuso horário). */
  hora: () => {
    const ms = Date.now();
    const alto = Math.floor(ms / 2 ** 32);
    const baixo = ms % 2 ** 32;
    const fuso = Math.round(-new Date().getTimezoneOffset() / 60) & 0xff;
    return new Uint8Array([
      0x10, 0x02,
      (alto >>> 24) & 0xff, (alto >>> 16) & 0xff, (alto >>> 8) & 0xff, alto & 0xff,
      (baixo >>> 24) & 0xff, (baixo >>> 16) & 0xff, (baixo >>> 8) & 0xff, baixo & 0xff,
      fuso, 0x01,
    ]);
  },

  heartbeat: () => new Uint8Array([0x10, 0x07, 0x01]), // mandar a cada 10 s
  pedirBateria: () => new Uint8Array([0x10, 0x03]),
  ligarWifi: () => new Uint8Array([0x11, 0x24, 0x01, 0x01]),
  desligarWifi: () => new Uint8Array([0x11, 0x24, 0x01, 0x00]),
  iniciarTransferencia: () => new Uint8Array([0x11, 0x25, 0x02]), // app oficial manda após entrar no Wi-Fi
  confirmarFoto: () => new Uint8Array([0x12, 0x07, 0x00]),
};

// ---------- leitura das mensagens do óculos ----------

export type InfoWifi = {
  ssid: string;
  senha: string;
  ip: string;
  porta: number;
  usuario: string;
  senhaFtp: string;
};

export type Evento =
  | { tipo: 'foto' } // o usuário tirou foto pelo botão
  | { tipo: 'bateria'; nivel: number }
  | { tipo: 'wifi'; info: InfoWifi | null } // null = óculos recusou ligar o Wi-Fi
  | { tipo: 'contadorFotos'; total: number }
  | { tipo: 'outro'; payload: Uint8Array };

/** Lê o pacote 11 20 (dados da rede do óculos). Retorna null se ele recusou (ex.: 11 20 00 03). */
export function lerInfoWifi(payload: Uint8Array): InfoWifi | null {
  if (payload.length < 4 || payload[2] !== 0x01) return null;
  const ip = Array.from(payload.slice(4, 8)).join('.');
  let p = 16; // pula 11 20 01 01 + ip + gateway + máscara
  const texto = () => {
    const n = payload[p];
    const s = deAscii(payload.slice(p + 1, p + 1 + n));
    p += 1 + n;
    return s;
  };
  const ssid = texto();
  const senha = texto();
  const porta = (payload[p] << 8) | payload[p + 1];
  p += 2;
  const usuario = texto();
  const senhaFtp = texto();
  return { ssid, senha, ip, porta, usuario, senhaFtp };
}

/**
 * Junta os pedaços que chegam pelo Bluetooth (a mensagem pode vir picada)
 * e devolve os eventos completos.
 */
export class Receptor {
  private buffer: number[] = [];

  receber(dados: Uint8Array): Evento[] {
    this.buffer.push(...dados);
    const eventos: Evento[] = [];
    while (this.buffer.length) {
      if (this.buffer[0] !== 0xed) {
        this.buffer.shift(); // descarta lixo até achar o início de um pacote
        continue;
      }
      if (this.buffer.length < 6) break;
      const tamanho = (this.buffer[4] << 8) | this.buffer[5];
      if (this.buffer.length < 6 + tamanho) break;
      const payload = new Uint8Array(this.buffer.slice(6, 6 + tamanho));
      this.buffer.splice(0, 6 + tamanho);
      eventos.push(interpretar(payload));
    }
    return eventos;
  }
}

function interpretar(payload: Uint8Array): Evento {
  const [grupo, cmd] = payload;
  if (grupo === 0x12 && cmd === 0x0f) return { tipo: 'foto' };
  if (grupo === 0x10 && cmd === 0x03 && payload.length >= 3) return { tipo: 'bateria', nivel: payload[2] };
  if (grupo === 0x11 && cmd === 0x20) return { tipo: 'wifi', info: lerInfoWifi(payload) };
  if (grupo === 0x12 && cmd === 0x03 && payload.length >= 4) return { tipo: 'contadorFotos', total: payload[3] };
  return { tipo: 'outro', payload };
}
