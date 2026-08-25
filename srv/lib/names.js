'use strict'

const PLANET_NAMES = [
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
  'Marfik', 'Markab', 'Matar', 'Mebsuta', 'Megrez', 'Meissa', 'Menkalinan', 'Menkar',
  'Menkent', 'Merope', 'Mesarthim', 'Miaplacidus', 'Mirfak', 'Mirzam', 'Muphrid', 'Naos',
  'Nekkar', 'Nihal', 'Peacock', 'Phact', 'Phecda', 'Pherkad', 'Rastaban', 'Ruchbah',
  'Rukbat', 'Sabik', 'Sadachbia', 'Sadalmelik', 'Sadr', 'Sarin', 'Seginus', 'Sheliak',
  'Sheratan', 'Sulafat', 'Syrma', 'Talitha', 'Tania', 'Taygeta', 'Tegmine', 'Tejat',
  'Turais', 'Tureis', 'Vindemia', 'Yed', 'Zavijava', 'Zubenelgenubi', 'Zubeneschamali', 'Zuben'
]

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

module.exports = { PLANET_NAMES, PLAYER_COLORS, NATIVE_COLOR, UNKNOWN_COLOR }
