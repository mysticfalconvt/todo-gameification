// Theme catalog for the Word Search arcade game. Used both for the chip
// picker on the setup screen and as the pool the server draws from when the
// player taps "Surprise me". A subset is flagged popular so the picker can
// show those above an expander.

export interface WordSearchTheme {
  name: string
  popular?: boolean
}

export const WORD_SEARCH_THEMES: readonly WordSearchTheme[] = [
  { name: 'Animals', popular: true },
  { name: 'Food', popular: true },
  { name: 'Sports', popular: true },
  { name: 'Music', popular: true },
  { name: 'Movies', popular: true },
  { name: 'Nature', popular: true },
  { name: 'Outer space' },
  { name: 'Mythology' },
  { name: 'Plants' },
  { name: 'Body parts' },
  { name: 'Tools' },
  { name: 'Kitchen' },
  { name: 'Clothing' },
  { name: 'Weather' },
  { name: 'Furniture' },
  { name: 'Vehicles' },
  { name: 'Instruments' },
  { name: 'Colors' },
  { name: 'Countries' },
  { name: 'Cities' },
  { name: 'Holidays' },
  { name: 'Birds' },
  { name: 'Fish' },
  { name: 'Insects' },
  { name: 'Trees' },
  { name: 'Fruit' },
  { name: 'Vegetables' },
  { name: 'Professions' },
  { name: 'Emotions' },
  { name: 'Buildings' },
]

export function popularThemes(): WordSearchTheme[] {
  return WORD_SEARCH_THEMES.filter((t) => t.popular)
}

export function moreThemes(): WordSearchTheme[] {
  return WORD_SEARCH_THEMES.filter((t) => !t.popular)
}
