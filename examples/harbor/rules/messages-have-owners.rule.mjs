export default {
  id: 'messages-have-owners',
  title: 'Every message has an owner',
  check({ catalog }) {
    return ['event', 'command', 'query']
      .flatMap((type) => catalog.resources(type))
      .filter((message) => !message.ownerRefs.length)
      .map((message) => `${message.name} has no owner`);
  },
};
