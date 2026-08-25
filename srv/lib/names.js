'use strict'

/**
 * Planet names are drawn from three pools. Keep the total at 150 or more -
 * that is the highest `planetCount` a game may request.
 */

const STAR_NAMES = [
  'Aldebaran', 'Altair', 'Antares', 'Arcturus', 'Bellatrix', 'Betelgeuse', 'Canopus', 'Capella',
  'Castor', 'Deneb', 'Electra', 'Elnath', 'Fomalhaut', 'Gacrux', 'Hadar', 'Izar',
  'Kochab', 'Merak', 'Mintaka', 'Mirach', 'Mizar', 'Nashira', 'Nunki', 'Polaris',
  'Pollux', 'Procyon', 'Rasalhague', 'Regulus', 'Rigel', 'Sadalbari', 'Saiph', 'Scheat',
  'Schedar', 'Shaula', 'Sirius', 'Spica', 'Suhail', 'Tarazed', 'Thuban', 'Unukalhai',
  'Vega', 'Vindemiatrix', 'Wezen', 'Yildun', 'Zaurak', 'Zosma', 'Acamar', 'Achernar',
  'Acrux', 'Adhara', 'Albireo', 'Alcor', 'Alcyone', 'Aldhibah', 'Alderamin', 'Algenib',
  'Algieba', 'Algol', 'Alhena', 'Alioth', 'Alkaid', 'Almach', 'Alnair', 'Alnilam',
  'Alnitak', 'Alphard', 'Alphecca', 'Alpheratz', 'Alshain', 'Altais', 'Aludra', 'Ankaa',
  'Arneb', 'Ascella', 'Asellus', 'Atlas', 'Atria', 'Avior', 'Azelfafage', 'Baten',
  'Caph', 'Cebalrai', 'Chara', 'Cursa', 'Dabih', 'Denebola', 'Diadem', 'Diphda',
  'Dubhe', 'Enif', 'Errai', 'Furud', 'Gienah', 'Gomeisa', 'Graffias', 'Grumium',
  'Hamal', 'Homam', 'Kaus', 'Keid', 'Kitalpha', 'Kornephoros', 'Lesath', 'Maia',
  'Marfik', 'Markab', 'Matar', 'Mebsuta', 'Megrez', 'Meissa', 'Menkalinan', 'Menkar'
]

/** Kiel institutions - clubs, pubs and beer gardens. */
const KIEL_VENUES = [
  'Die Pumpe',
  'Traum GmbH',
  'Max',
  'Räucherei',
  'Alte Meierei',
  'Forstbaumschule',
  'Seeburg',
  'Hansa 48',
  'Schaubude',
  'Luna'
]

/** Bands of the 1967-1990 era. */
const BANDS = [
  // Krautrock and German rock
  'Kraftwerk', 'Can', 'Neu!', 'Amon Düül', 'Tangerine Dream', 'Guru Guru',
  'Grobschnitt', 'Novalis', 'Eloy', 'Birth Control', 'Kraan', 'Jane', 'Embryo', 'Passport',
  // Neue Deutsche Welle and Deutschrock
  'Ton Steine Scherben', 'Ideal', 'Spliff', 'Trio', 'Extrabreit', 'Fehlfarben',
  'Einstürzende Neubauten', 'BAP', 'Rheingold', 'Nena',
  // East German rock
  'Puhdys', 'Karat', 'Silly', 'City', 'Pankow',
  // Hard rock and metal
  'Scorpions', 'Accept', 'Deep Purple', 'Black Sabbath', 'Led Zeppelin',
  'Motörhead', 'Iron Maiden', 'Metallica', 'Rush',
  // Prog and classic rock
  'Pink Floyd', 'King Crimson', 'Yes', 'Genesis', 'Jethro Tull',
  'The Doors', 'Cream', 'Santana', 'Queen',
  // Punk, post-punk and new wave
  'Ramones', 'Blondie', 'Talking Heads', 'The Clash', 'Joy Division',
  'The Cure', 'Depeche Mode', 'New Order', 'Dire Straits', 'ABBA'
]

const PLANET_NAMES = [...STAR_NAMES, ...KIEL_VENUES, ...BANDS]

/** Player colors, high contrast against a dark star map. */
const PLAYER_COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231',
  '#911eb4', '#42d4f4', '#f032e6', '#ffe119',
  '#469990', '#9a6324', '#800000', '#000075'
]

/** Color of native-held planets once explored. */
const NATIVE_COLOR = '#a9a9a9'

/** Unexplored planets on the star map. */
const UNKNOWN_COLOR = '#4a4a4a'

module.exports = {
  PLANET_NAMES,
  STAR_NAMES,
  KIEL_VENUES,
  BANDS,
  PLAYER_COLORS,
  NATIVE_COLOR,
  UNKNOWN_COLOR
}
