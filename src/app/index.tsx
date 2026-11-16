import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Speech from 'expo-speech';
import { useOculos } from '../oculos/useOculos';
import { Evento } from '../oculos/protocolo';
import { baixarFotoNova, mensagemDoCiclo } from '../oculos/ciclo';
import { lerTexto } from '../oculos/ocr';

/**
 * Tela principal do Lumen.
 * Fluxo: foto pelo botão do óculos -> o app baixa a foto -> lê o texto -> fala em voz alta.
 * Pensada para quem não enxerga ou enxerga pouco: alto contraste, um botão enorme,
 * textos grandes e tudo que importa é dito em voz alta.
 */

const COR = {
  fundo: '#10305A',
  texto: '#FFFFFF',
  apagado: '#B7C7DD',
  destaque: '#FFD447',
  sobreDestaque: '#10305A',
};

const TEXTO_INICIAL =
  'Lumen pronto. Quando você tirar uma foto com o óculos, eu leio o texto em voz alta.';

function falar(frase: string, aoTerminar?: () => void) {
  Speech.stop();
  Speech.speak(frase, {
    language: 'pt-BR',
    rate: 1.0,
    onDone: aoTerminar,
    onStopped: aoTerminar,
    onError: aoTerminar,
  });
}

export default function Inicio() {
  const [texto, setTexto] = useState(TEXTO_INICIAL);
  const [foto, setFoto] = useState<string | null>(null);
  const [etapa, setEtapa] = useState<string | null>(null);
  const [falando, setFalando] = useState(false);
  const ocupado = useRef(false);

  const { estado, bateria, erro, conexaoRef } = useOculos((evento: Evento) => {
    if (evento.tipo === 'foto') processarFoto();
  });

  async function processarFoto() {
    const conexao = conexaoRef.current;
    if (!conexao || ocupado.current) return; // ignora fotos tiradas enquanto a anterior é processada
    ocupado.current = true;
    falar('Foto recebida. Lendo.');
    try {
      const arquivo = await baixarFotoNova(conexao, setEtapa);
      if (!arquivo) {
        setTexto('O óculos não tem nenhuma foto.');
        falar('O óculos não tem nenhuma foto.');
        return;
      }
      setFoto(arquivo.uri);
      setEtapa('Lendo o texto…');
      const lido = await lerTexto(arquivo.uri);
      const resultado = lido || 'Não encontrei texto nessa foto.';
      setTexto(resultado);
      setFalando(true);
      falar(resultado, () => setFalando(false));
    } catch (e) {
      console.log('ERRO NO CICLO:', e);
      const mensagem = mensagemDoCiclo(e);
      setTexto(mensagem);
      falar(mensagem);
    } finally {
      setEtapa(null);
      ocupado.current = false;
    }
  }

  // Avisa por voz quando o óculos conecta ou desconecta (fora do ciclo da foto).
  const estadoAnterior = useRef(estado);
  useEffect(() => {
    if (!ocupado.current) {
      if (estado === 'conectado' && estadoAnterior.current !== 'conectado') falar('Óculos conectado');
      if (estado === 'desconectado' && estadoAnterior.current === 'conectado') falar('Óculos desconectado');
    }
    estadoAnterior.current = estado;
  }, [estado]);

  useEffect(() => () => void Speech.stop(), []);

  const status =
    etapa ??
    (estado === 'conectado'
      ? `Óculos conectado${bateria !== null ? `, bateria em ${bateria}%` : ''}`
      : estado === 'conectando'
        ? 'Procurando o óculos…'
        : erro ?? 'Óculos desconectado. Tentando de novo…');

  function alternarLeitura() {
    if (falando) {
      Speech.stop();
      setFalando(false);
      return;
    }
    setFalando(true);
    falar(texto, () => setFalando(false));
  }

  return (
    <SafeAreaView style={estilos.tela}>
      <Text style={estilos.status} accessibilityRole="header" accessibilityLiveRegion="polite">
        {status}
      </Text>

      <ScrollView style={estilos.areaTexto} contentContainerStyle={estilos.areaTextoConteudo}>
        {foto && (
          <Image
            source={{ uri: foto }}
            style={estilos.foto}
            resizeMode="cover"
            accessibilityLabel="Última foto tirada pelo óculos"
          />
        )}
        <Text style={estilos.rotulo}>Último texto lido</Text>
        <Text style={estilos.texto} selectable>
          {texto}
        </Text>
      </ScrollView>

      <Pressable
        onPress={alternarLeitura}
        accessibilityRole="button"
        accessibilityLabel={falando ? 'Parar leitura' : 'Ouvir o texto de novo'}
        accessibilityHint={falando ? undefined : 'Lê em voz alta o último texto encontrado'}
        style={({ pressed }) => [estilos.botao, pressed && estilos.botaoPressionado]}
      >
        <Text style={estilos.botaoTexto}>{falando ? 'Parar' : 'Ouvir de novo'}</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const estilos = StyleSheet.create({
  tela: { flex: 1, backgroundColor: COR.fundo, paddingHorizontal: 20, paddingBottom: 20 },
  status: { color: COR.apagado, fontSize: 18, paddingVertical: 16 },
  areaTexto: { flex: 1 },
  areaTextoConteudo: { paddingBottom: 24 },
  foto: { width: '100%', aspectRatio: 4 / 3, borderRadius: 16, marginBottom: 16 },
  rotulo: { color: COR.destaque, fontSize: 16, fontWeight: '600', marginBottom: 8 },
  texto: { color: COR.texto, fontSize: 28, lineHeight: 38 },
  botao: {
    minHeight: '30%',
    backgroundColor: COR.destaque,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  botaoPressionado: { opacity: 0.8 },
  botaoTexto: { color: COR.sobreDestaque, fontSize: 34, fontWeight: '700' },
});
