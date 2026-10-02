export function needsPreparation(previous,{tag,opsCommit,forkBaseCommit,force=false}) {
  return force || previous?.status!=='ready' || previous.upstreamTag!==tag || previous.opsCommit!==opsCommit || ![previous.forkBaseCommit,previous.sourceCommit].includes(forkBaseCommit);
}
