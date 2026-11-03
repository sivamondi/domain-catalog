// Compares two JSON Schemas and classifies each change by who it can break.

const typeOf = (schema) => {
  if (schema?.$ref) return `ref:${schema.$ref}`;
  const { type } = schema || {};
  return Array.isArray(type) ? [...type].sort().join('|') : type;
};

/**
 * `consumer` (default): can existing readers still handle data from the new schema?
 * `producer`: can existing writers still produce data the new schema accepts?
 * `full`: both must hold.
 */
export function compareSchemas(before, after, { mode = 'consumer' } = {}) {
  if (!['consumer', 'producer', 'full'].includes(mode)) throw new Error(`Unknown compatibility mode: ${mode}`);
  const changes = [];
  const add = (kind, at, message, breaks) => changes.push({
    kind,
    path: at || '/',
    message,
    breaking: mode === 'full' ? breaks.length > 0 : breaks.includes(mode),
  });

  const walk = (a, b, at) => {
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return;
    const [typeA, typeB] = [typeOf(a), typeOf(b)];
    if (typeA !== typeB) {
      add('type-changed', at, `Type changed from ${typeA ?? 'any'} to ${typeB ?? 'any'}`, ['consumer', 'producer']);
      return;
    }
    const propsA = a.properties || {};
    const propsB = b.properties || {};
    const requiredA = new Set(a.required || []);
    const requiredB = new Set(b.required || []);
    for (const name of Object.keys(propsA)) {
      const child = `${at}/${name}`;
      if (!(name in propsB)) {
        add('property-removed', child, `Property "${name}" was removed`, b.additionalProperties === false ? ['consumer', 'producer'] : ['consumer']);
      } else {
        walk(propsA[name], propsB[name], child);
      }
    }
    for (const name of Object.keys(propsB)) {
      if (!(name in propsA)) {
        add('property-added', `${at}/${name}`, `Property "${name}" was added${requiredB.has(name) ? ' as required' : ''}`, requiredB.has(name) ? ['producer'] : []);
      }
    }
    for (const name of requiredA) {
      if (!requiredB.has(name) && name in propsB) add('no-longer-required', `${at}/${name}`, `Property "${name}" is no longer required`, ['consumer']);
    }
    for (const name of requiredB) {
      if (!requiredA.has(name) && name in propsA) add('now-required', `${at}/${name}`, `Property "${name}" is now required`, ['producer']);
    }
    if (a.enum || b.enum) {
      const [enumA, enumB] = [a.enum || [], b.enum || []];
      if (!a.enum) add('enum-added', at, 'Values are now restricted to an enum', ['producer']);
      else if (!b.enum) add('enum-removed', at, 'Enum restriction was removed', ['consumer']);
      else {
        for (const value of enumA) if (!enumB.includes(value)) add('enum-value-removed', at, `Enum value ${JSON.stringify(value)} was removed`, ['producer']);
        for (const value of enumB) if (!enumA.includes(value)) add('enum-value-added', at, `Enum value ${JSON.stringify(value)} was added`, ['consumer']);
      }
    }
    if (a.format !== b.format) add('format-changed', at, `Format changed from ${a.format ?? 'none'} to ${b.format ?? 'none'}`, ['consumer', 'producer']);
    if (a.items || b.items) walk(a.items || {}, b.items || {}, `${at}/items`);
  };

  walk(before, after, '');
  return { compatible: !changes.some((c) => c.breaking), mode, changes };
}
