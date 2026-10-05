// A server-verified name is still attacker-chosen text. Never render unsafe labels.
const RENDERABLE_ENS = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function isRenderableEnsName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 100 && RENDERABLE_ENS.test(name);
}
