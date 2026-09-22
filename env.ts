/** Lee una variable de entorno obligatoria y falla con un mensaje claro si falta. */
export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

export function envOr(name: string, fallback: string): string {
  return process.env[name] || fallback;
}
