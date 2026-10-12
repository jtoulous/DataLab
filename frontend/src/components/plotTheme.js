// Theme sombre commun a tous les graphiques du Lab (meme ambiance que le chart de trading)
export const PLOT_COLORS = {
    real: '#ff7f32',
    null: 'rgba(224, 224, 224, 0.5)',
    up: '#26a69a',
    down: '#ef5350',
    series: ['#3987e5', '#d95926', '#9085e9', '#c98500', '#d55181'],
    grid: 'rgba(255, 255, 255, 0.05)',
    text: 'rgba(255, 255, 255, 0.65)',
};

// Divergente (bleu -> gris neutre -> orange) pour les correlations / valeurs centrees sur 0
export const DIVERGING = [[0, '#3987e5'], [0.5, '#2a2a30'], [1, '#d95926']];
// Sequentielle (une teinte, du sombre au clair) pour les grandeurs positives
export const SEQUENTIAL = [[0, '#1b1b22'], [1, '#ff9a52']];
