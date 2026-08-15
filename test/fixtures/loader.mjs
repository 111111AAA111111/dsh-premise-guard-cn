const fixtures = new URL('./', import.meta.url)

export function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/schemastery') return { url: new URL('schemastery.mjs', fixtures).href, shortCircuit: true }
  if (specifier === '@deepseek-ai/dsh-llm') return { url: new URL('dsh-llm.mjs', fixtures).href, shortCircuit: true }
  return nextResolve(specifier, context)
}
