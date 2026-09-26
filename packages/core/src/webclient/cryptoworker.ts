// Point d'entrée du Web Worker de chiffrement de la page du téléphone
// (compilé en public/phone/cw.js). Le travail lui-même est dans cryptojob.ts.
import { makeCryptoRunner, type CryptoJob } from './cryptojob.js'

interface WorkerScope {
  postMessage(msg: unknown, transfer?: Transferable[]): void
  onmessage: ((ev: MessageEvent) => void) | null
}
const scope = self as unknown as WorkerScope
const runner = makeCryptoRunner()

scope.onmessage = (ev: MessageEvent) => {
  const { reply, transfer } = runner.handle(ev.data as CryptoJob)
  scope.postMessage(reply, transfer)
}
// prêt : la page peut confier ses morceaux (elle attend ce signal avant de
// transférer quoi que ce soit, pour pouvoir se rabattre sur son propre fil)
scope.postMessage({ ready: true, engine: runner.engine })
