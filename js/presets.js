// Predictor sets offered in step 4. Each entry lists survey columns in the
// order they appear in the results, the label shown for each, and whether
// the column enters as a number (one slope) or a category (one coefficient
// per answer). Columns missing from a loaded file are skipped and reported.
// Edit this file on GitHub to change or add sets.
window.SPEER_PRESETS = [
  {
    name: 'SPEER standard controls',
    note: 'Reference groups: liberal, Democrat, White, suburban, no bachelor\'s degree.',
    weight: 'Weight',
    predictors: [
      { col: 'S_Moderate_d', label: 'Moderate', kind: 'number' },
      { col: 'S_Conservative_d', label: 'Conservative', kind: 'number' },
      { col: 'Independent_d', label: 'Independent', kind: 'number' },
      { col: 'Republican_d', label: 'Republican', kind: 'number' },
      { col: 'BibLit_d', label: 'Biblical Literalist', kind: 'number' },
      { col: 'Attend', label: 'Church Attendance', kind: 'number' },
      { col: 'Evangelical_d', label: 'Evangelical', kind: 'number' },
      { col: 'Bachelors_d', label: 'Degree Holder', kind: 'number' },
      { col: 'AgeNum', label: 'Age', kind: 'number' },
      { col: 'McAgeSq', label: 'MC Age Squared', kind: 'number' },
      { col: 'Woman_d', label: 'Woman', kind: 'number' },
      { col: 'Black_d', label: 'Black', kind: 'number' },
      { col: 'Hispanic_d', label: 'Hispanic', kind: 'number' },
      { col: 'OthRace_d', label: 'Other Race', kind: 'number' },
      { col: 'Married_d', label: 'Married', kind: 'number' },
      { col: 'Children_d', label: 'Has Children', kind: 'number' },
      { col: 'ZIncome', label: 'Standardized Income', kind: 'number' },
      { col: 'Rural_d', label: 'Rural', kind: 'number' },
      { col: 'Urban_d', label: 'Urban', kind: 'number' },
      { col: 'South_d', label: 'South', kind: 'number' },
    ],
  },
  {
    name: 'SPEER standard controls + attitudes',
    note: 'Standard controls plus political trust, individualism and the fear scale, as in the CCUS models.',
    weight: 'Weight',
    extends: 'SPEER standard controls',
    predictors: [
      { col: 'POP_Trust', label: 'POP_Trust', kind: 'number' },
      { col: 'CCWS_Individualism_s', label: 'Individualism', kind: 'number' },
      { col: 'FR_s', label: 'FR_s', kind: 'number' },
    ],
  },
  {
    name: 'SPEER standard controls + climate belief',
    weight: 'Weight',
    extends: 'SPEER standard controls',
    predictors: [
      { col: 'CC_Belief', label: 'CC Belief', kind: 'number' },
    ],
  },
];

// Display labels used wherever these columns appear, whether or not a set is chosen
window.SPEER_LABELS = {
  SN_People: 'People', SN_Power: 'Power',
  B5_Openness_s: 'Openness', B5_Conscientiousness_s: 'Conscientiousness', B5_Extraversion_s: 'Extraversion',
  B5_Agreeableness_s: 'Agreeableness', B5_Neuroticism_s: 'Neuroticism',
  POP_4s: 'Populism Scale', Bachelors_d: 'Degree Holder', South_d: 'South', Urban_d: 'Urban', Rural_d: 'Rural',
  AgeNum: 'Age', McAge: 'MC Age', McAgeSq: 'MC Age Squared', Woman_d: 'Woman',
  Democrat_d: 'Democrat', Independent_d: 'Independent', Republican_d: 'Republican',
  S_Liberal_d: 'Liberal', S_Moderate_d: 'Moderate', S_Conservative_d: 'Conservative',
  E_Liberal_d: 'Economic Liberal', E_Moderate_d: 'Economic Moderate', E_Conservative_d: 'Economic Conservative',
  BibLit_d: 'Biblical Literalist', Evangelical_d: 'Evangelical', White_d: 'White', Black_d: 'Black',
  Hispanic_d: 'Hispanic', OthRace_d: 'Other Race', Married_d: 'Married', Children_d: 'Has Children',
  ZIncome: 'Standardized Income', Census_Division: 'Census Division', Census_Region: 'Census Region',
  xregion: 'Region', Attend: 'Church Attendance', CC_Belief: 'CC Belief', CC_Risk: 'CC Risk',
  CCWS_Individualism_s: 'Individualism',
};
