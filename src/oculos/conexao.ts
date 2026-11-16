import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, Device, State, Subscription } from 'react-native-ble-plx';
import { deBase64, paraBase64 } from './base64';
import {
  Comandos,
  Empacotador,
  ENDERECO_OCULOS,
  Evento,
  InfoWifi,
  Receptor,
  UUID_ESCRITA,
  UUID_NOTIFICACAO,
  UUID_SERVICO,
} from './protocolo';

export type EstadoConexao = 'desconectado' | 'conectando' | 'conectado';

type Ouvintes = {
  aoMudarEstado?: (estado: EstadoConexao) => void;
  aoEvento?: (evento: Evento) => void;
};

/**
 * Cuida da conversa com o óculos pelo Bluetooth (BLE):
 * conecta, ativa as notificações, faz o handshake, mantém o heartbeat
 * e transforma o que chega em eventos (foto, bateria, Wi-Fi...).
 */
export class ConexaoOculos {
  private manager = new BleManager();
  private dispositivo: Device | null = null;
  private empacotador = new Empacotador();
  private receptor = new Receptor();
  private inscricoes: Subscription[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private _estado: EstadoConexao = 'desconectado';
  private esperaWifi: ((info: InfoWifi | null) => void) | null = null;

  constructor(private ouvintes: Ouvintes) {}

  get estado(): EstadoConexao {
    return this._estado;
  }

  async conectar(): Promise<void> {
    if (this._estado !== 'desconectado') return;
    this.mudarEstado('conectando');
    try {
      if (!(await pedirPermissoes())) throw new Error('PERMISSAO');
      await this.esperarBluetoothLigado();

      // No Android dá pra conectar direto pelo endereço, sem precisar procurar.
      const dispositivo = await this.manager.connectToDevice(ENDERECO_OCULOS, {
        requestMTU: 247,
        timeout: 15000,
      });
      await dispositivo.discoverAllServicesAndCharacteristics();
      this.dispositivo = dispositivo;
      this.receptor = new Receptor();

      this.inscricoes.push(dispositivo.onDisconnected(() => this.aoCair()));
      this.inscricoes.push(
        dispositivo.monitorCharacteristicForService(UUID_SERVICO, UUID_NOTIFICACAO, (erro, carac) => {
          if (erro || !carac?.value) return;
          for (const evento of this.receptor.receber(deBase64(carac.value))) this.tratar(evento);
        }),
      );

      await this.enviar(Comandos.handshake());
      await this.enviar(Comandos.hora());
      await this.enviar(Comandos.heartbeat());
      await this.enviar(Comandos.pedirBateria());
      this.heartbeat = setInterval(() => {
        this.enviar(Comandos.heartbeat()).catch(() => {});
      }, 10_000);

      this.mudarEstado('conectado');
    } catch (erro) {
      this.limpar();
      this.mudarEstado('desconectado');
      throw erro;
    }
  }

  async enviar(payload: Uint8Array): Promise<void> {
    if (!this.dispositivo) throw new Error('SEM_CONEXAO');
    const pacote = this.empacotador.montar(payload);
    await this.dispositivo.writeCharacteristicWithResponseForService(
      UUID_SERVICO,
      UUID_ESCRITA,
      paraBase64(pacote),
    );
  }

  /** Pede ao óculos para ligar o Wi-Fi e devolve o nome, a senha da rede e os dados do FTP. */
  async ligarWifi(): Promise<InfoWifi> {
    const resposta = new Promise<InfoWifi | null>((resolve, rejeitar) => {
      this.esperaWifi = resolve;
      setTimeout(() => {
        if (this.esperaWifi === resolve) {
          this.esperaWifi = null;
          rejeitar(new Error('WIFI_SEM_RESPOSTA'));
        }
      }, 10_000);
    });
    await this.enviar(Comandos.ligarWifi());
    const info = await resposta;
    if (!info) throw new Error('WIFI_RECUSADO');
    return info;
  }

  /** Espera o Bluetooth voltar (ele pode cair quando o Wi-Fi do óculos liga). */
  async aguardarConexao(limiteMs: number): Promise<boolean> {
    const fim = Date.now() + limiteMs;
    while (Date.now() < fim) {
      if (this._estado === 'conectado') return true;
      await new Promise<void>((r) => setTimeout(r, 500));
    }
    return false;
  }

  encerrar(): void {
    const dispositivo = this.dispositivo;
    this.limpar();
    dispositivo?.cancelConnection().catch(() => {});
    this.manager.destroy();
  }

  // ---------- interno ----------

  private tratar(evento: Evento) {
    if (evento.tipo === 'wifi' && this.esperaWifi) {
      const responder = this.esperaWifi;
      this.esperaWifi = null;
      responder(evento.info);
    }
    if (evento.tipo === 'foto') {
      this.enviar(Comandos.confirmarFoto()).catch(() => {}); // o app oficial confirma o aviso
    }
    this.ouvintes.aoEvento?.(evento);
  }

  private aoCair() {
    this.limpar();
    this.mudarEstado('desconectado');
  }

  private limpar() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const inscricao of this.inscricoes) inscricao.remove();
    this.inscricoes = [];
    this.dispositivo = null;
  }

  private mudarEstado(estado: EstadoConexao) {
    if (estado === this._estado) return;
    this._estado = estado;
    this.ouvintes.aoMudarEstado?.(estado);
  }

  private async esperarBluetoothLigado(): Promise<void> {
    if ((await this.manager.state()) === State.PoweredOn) return;
    await new Promise<void>((resolve, rejeitar) => {
      const inscricao = this.manager.onStateChange((estado) => {
        if (estado === State.PoweredOn) {
          inscricao.remove();
          clearTimeout(limite);
          resolve();
        }
      }, true);
      const limite = setTimeout(() => {
        inscricao.remove();
        rejeitar(new Error('BLUETOOTH_DESLIGADO'));
      }, 10_000);
    });
  }
}

async function pedirPermissoes(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (Number(Platform.Version) >= 31) {
    const P = PermissionsAndroid.PERMISSIONS;
    // A localização não é usada pelo Bluetooth, mas o Wi-Fi precisa dela; pedimos tudo de uma vez.
    const resultado = await PermissionsAndroid.requestMultiple([
      P.BLUETOOTH_SCAN,
      P.BLUETOOTH_CONNECT,
      P.ACCESS_FINE_LOCATION,
    ]);
    const ok = PermissionsAndroid.RESULTS.GRANTED;
    return resultado[P.BLUETOOTH_SCAN] === ok && resultado[P.BLUETOOTH_CONNECT] === ok;
  }
  const resultado = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  );
  return resultado === PermissionsAndroid.RESULTS.GRANTED;
}

/** Traduz os erros técnicos para frases que fazem sentido para quem usa o app. */
export function mensagemDeErro(erro: unknown): string {
  const texto = String((erro as Error)?.message ?? erro);
  if (texto.includes('PERMISSAO')) return 'Permita o acesso ao Bluetooth nas configurações do celular.';
  if (texto.includes('BLUETOOTH_DESLIGADO')) return 'Ligue o Bluetooth do celular.';
  return 'Óculos não encontrado. Confira se ele está ligado e perto do celular.';
}
