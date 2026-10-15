import { createContext } from 'react';

// Hauteur des graphiques d'un panneau : multiple de leur hauteur de base (reglable depuis l'entete du panneau)
export const PlotScaleContext = createContext(1);
export const PLOT_SCALES = [1, 1.8, 2.6];
export const DEFAULT_PLOT_SCALE = 1.8;
