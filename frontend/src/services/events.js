// Mini bus d'evenements : messages WS consommes directement par les pages concernees
const listeners = {};

export const appEvents = {
    on(event, callback) {
        (listeners[event] ||= new Set()).add(callback);
        return () => listeners[event].delete(callback);
    },

    emit(event, payload) {
        listeners[event]?.forEach((callback) => {
            try {
                callback(payload);
            } catch (error) {
                console.error(`appEvents '${event}' listener error`, error);
            }
        });
    },
};
