import { PermissionsAndroid, Platform } from 'react-native';
import WifiManager from 'react-native-wifi-reborn';

/** O Android exige a permissão de localização para o app se conectar numa rede Wi-Fi. */
async function garantirPermissao(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const permissao = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
  if (await PermissionsAndroid.check(permissao)) return;
  const resultado = await PermissionsAndroid.request(permissao);
  if (resultado !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('PERMISSAO_LOCALIZACAO');
}

/**
 * Conecta o celular na rede do óculos.
 * No Android 10 ou mais novo, o próprio sistema mostra um aviso pedindo para confirmar a conexão,
 * e o app passa a usar essa rede (que não tem internet) só para falar com o óculos.
 */
export async function entrarNaRedeDoOculos(ssid: string, senha: string): Promise<void> {
  await garantirPermissao();
  await WifiManager.connectToProtectedWifiSSID({
    ssid,
    password: senha || null,
    isWEP: false,
    isHidden: false,
    timeout: 25,
  });
  if (Platform.OS === 'android' && Number(Platform.Version) < 29) {
    // Androids antigos: força o app a usar o Wi-Fi mesmo sem internet
    await WifiManager.forceWifiUsageWithOptions(true, { noInternet: true }).catch(() => {});
  }
}

export async function sairDaRedeDoOculos(): Promise<void> {
  await WifiManager.disconnect().catch(() => false);
  if (Platform.OS === 'android' && Number(Platform.Version) < 29) {
    await WifiManager.forceWifiUsageWithOptions(false, { noInternet: true }).catch(() => {});
  }
}

export function ipDoCelular(): Promise<string> {
  return WifiManager.getIP();
}
