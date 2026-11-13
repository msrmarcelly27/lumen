import { useEffect, useRef, useState } from 'react';
import { ConexaoOculos, EstadoConexao, mensagemDeErro } from './conexao';
import { Evento } from './protocolo';

const esperar = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Conecta no óculos assim que a tela abre e tenta de novo a cada 5 s se cair.
 * Devolve o estado da conexão, a bateria e o último erro (em português).
 */
export function useOculos(aoEvento?: (evento: Evento) => void) {
  const [estado, setEstado] = useState<EstadoConexao>('desconectado');
  const [bateria, setBateria] = useState<number | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const conexaoRef = useRef<ConexaoOculos | null>(null);
  const aoEventoRef = useRef(aoEvento);
  aoEventoRef.current = aoEvento;

  useEffect(() => {
    let ativo = true;
    const conexao = new ConexaoOculos({
      aoMudarEstado: setEstado,
      aoEvento: (evento) => {
        if (evento.tipo === 'bateria') setBateria(evento.nivel);
        aoEventoRef.current?.(evento);
      },
    });

    conexaoRef.current = conexao;

    (async () => {
      while (ativo) {
        if (conexao.estado === 'desconectado') {
          try {
            await conexao.conectar();
            setErro(null);
          } catch (e) {
            if (ativo) setErro(mensagemDeErro(e));
          }
        }
        await esperar(5000);
      }
    })();

    return () => {
      ativo = false;
      conexao.encerrar();
    };
  }, []);

  return { estado, bateria, erro, conexaoRef };
}
