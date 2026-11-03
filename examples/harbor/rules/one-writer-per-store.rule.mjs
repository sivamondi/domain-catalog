export default {
  id: 'one-writer-per-store',
  title: 'Each data store has one writer',
  severity: 'warn',
  check({ catalog }) {
    return catalog.resources('datastore')
      .map((store) => ({ store, writers: catalog.incoming(store).filter((edge) => edge.label === 'writes to') }))
      .filter(({ writers }) => writers.length > 1)
      .map(({ store, writers }) => `${store.name} is written by ${writers.map((edge) => edge.from.name).join(', ')}`);
  },
};
