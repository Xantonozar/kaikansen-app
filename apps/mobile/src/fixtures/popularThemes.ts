/**
 * Popular-themes fixture — REAL production catalogue data (public fields only:
 * titles, slugs, media URLs, counters), pulled from the shared `kaikansen`
 * database's themecaches collection on 2026-11-07 (the 20 isPopular documents
 * in popularRank order).
 *
 * Used by the mobile app's fixture mode (see src/api.ts) when no
 * EXPO_PUBLIC_API_URL is configured, so the read path can be demoed and
 * verified without a reachable Atlas. Only the fields the shared contracts
 * model are kept; `embedding` and `__v` are excluded, as the API does.
 */
import type { ThemeDetail } from '@kaikansen/contracts';

export const popularThemesFixture: ThemeDetail[] = [
  {
    "id": "69e55f5d96b4cfa3b8f89d7d",
    "slug": "neon_genesis_evangelion-op1-919",
    "animethemesId": 919,
    "anilistId": 30,
    "kitsuId": null,
    "songTitle": "Zankoku na Tenshi no Thesis",
    "animeTitle": "Neon Genesis Evangelion",
    "animeTitleEnglish": "Neon Genesis Evangelion",
    "animeTitleAlternative": [
      "新世紀エヴァンゲリオン",
      "Shin Seiki Evangelion",
      "NGE",
      "Eva",
      "ניאון ג'נסיס אוונגליון",
      "อีวานเกเลียน มหาสงครามวันพิพากษา",
      "Евангелион"
    ],
    "artistName": "Youko Takahashi",
    "allArtists": [
      "Youko Takahashi"
    ],
    "artistSlugs": [
      "youko_takahashi"
    ],
    "artistRoles": [
      "performer"
    ],
    "animeSeason": "FALL",
    "animeSeasonYear": 1995,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/n9L9LIzW1n1hYNvR8IMuvnU6ZpJC4xKkzuvGi8Md.jpg",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/u6AvvzmaRjMF4ioWCgQsXQLBMRxINhW0vR6VW3O8.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/30-gEMoHHIqxDgN.jpg",
    "animeStudios": [
      "Gainax",
      "Tatsunoko Production",
      "TV Tokyo",
      "ADV Films",
      "Kadokawa Shoten",
      "NAS",
      "GKIDS",
      "Madman Entertainment"
    ],
    "animeSeries": [
      "Neon Genesis Evangelion"
    ],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 1027,
        "version": "NC+BD",
        "episodes": null,
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC",
          "BD"
        ],
        "videoSources": [
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/NeonGenesisEvangelion-OP1.webm",
            "source": "BD",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/NeonGenesisEvangelion-OP1.webm",
        "audioUrl": "https://v.animethemes.moe/NeonGenesisEvangelion-OP1.webm",
        "duration": 90
      }
    ],
    "videoUrl": "https://v.animethemes.moe/NeonGenesisEvangelion-OP1.webm",
    "audioUrl": "https://v.animethemes.moe/NeonGenesisEvangelion-OP1.webm",
    "mood": [
      "mysterious",
      "epic",
      "emotional"
    ],
    "avgRating": 10,
    "totalRatings": 1,
    "totalWatches": 5,
    "totalListens": 2,
    "duration": null,
    "isPopular": true,
    "popularRank": 1,
    "syncedAt": "2026-04-21T13:39:19.217Z",
    "createdAt": null,
    "updatedAt": "2026-09-10T15:51:16.788Z"
  },
  {
    "id": "69df88907a385727d1f6b4d2",
    "slug": "tokyo_ghoul-op1-5695",
    "animethemesId": 5695,
    "anilistId": 20605,
    "kitsuId": null,
    "songTitle": "unravel",
    "animeTitle": "Tokyo Ghoul",
    "animeTitleEnglish": "Tokyo Ghoul",
    "animeTitleAlternative": [
      "東京喰種 トーキョーグール",
      "Tokyo Kushu",
      "שדי טוקיו",
      "东京食种",
      "طوكيو غول",
      "Токийский гуль"
    ],
    "artistName": "TK from Ling tosite sigure",
    "allArtists": [
      "TK from Ling tosite sigure"
    ],
    "artistSlugs": [
      "tk"
    ],
    "artistRoles": [
      "performer"
    ],
    "animeSeason": "SUMMER",
    "animeSeasonYear": 2014,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/lXVlVtsCoYd2kmM4QsbXWqd63eJu2rX6OXZkia0k.jpg",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/pj7O5mkQS2soB2zNLkHfNfZhD0egRsATGkqhHhkA.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/20605-RCJ7M71zLmrh.jpg",
    "animeStudios": [
      "Pierrot",
      "Studio Pierrot",
      "Marvelous",
      "TC Entertainment"
    ],
    "animeSeries": [
      "Tokyo Ghoul"
    ],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 6532,
        "version": "NC+BD",
        "episodes": null,
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC",
          "BD"
        ],
        "videoSources": [
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/TokyoGhoul-OP1.webm",
            "source": "BD",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/TokyoGhoul-OP1.webm",
        "audioUrl": "https://v.animethemes.moe/TokyoGhoul-OP1.webm",
        "duration": 90
      }
    ],
    "videoUrl": "https://v.animethemes.moe/TokyoGhoul-OP1.webm",
    "audioUrl": "https://v.animethemes.moe/TokyoGhoul-OP1.webm",
    "mood": [
      "mysterious",
      "dark",
      "epic",
      "emotional"
    ],
    "avgRating": 10,
    "totalRatings": 4,
    "totalWatches": 3,
    "totalListens": 1,
    "duration": null,
    "isPopular": true,
    "popularRank": 2,
    "syncedAt": "2026-04-20T20:45:38.222Z",
    "createdAt": "2026-04-15T12:46:08.873Z",
    "updatedAt": "2026-04-27T12:24:29.716Z"
  },
  {
    "id": "69e5571d96b4cfa3b8f89d40",
    "slug": "fullmetal_alchemist_brotherhood-op1-3434",
    "animethemesId": 3434,
    "anilistId": 5114,
    "kitsuId": null,
    "songTitle": "again",
    "animeTitle": "Fullmetal Alchemist: Brotherhood",
    "animeTitleEnglish": "Fullmetal Alchemist: Brotherhood",
    "animeTitleAlternative": [
      "鋼の錬金術師 FULLMETAL ALCHEMIST",
      "Hagane no Renkinjutsushi: FULLMETAL ALCHEMIST",
      "FMA",
      "FMAB",
      "Hagaren",
      "الخيميائي الفولاذي",
      "אלכימאי המתכת: אחוות אחים",
      "Full Metal Alchemist: Brotherhood",
      "钢之炼金术师 FULLMETAL ALCHEMIST",
      "แขนกล คนแปรธาตุ: บราเธอร์ฮูด",
      "Stalowy alchemik: Misja braci",
      "Сталевий алхімік. Братерство",
      "Стальной алхимик: Братство"
    ],
    "artistName": "Yui",
    "allArtists": [
      "Yui"
    ],
    "artistSlugs": [
      "yui"
    ],
    "artistRoles": [
      "performer"
    ],
    "animeSeason": "SPRING",
    "animeSeasonYear": 2009,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/gfq2CHywTELCdwvhg1qbHQ5kj5uoDoxFOvJ64qcG.png",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/WhPRDYBAcmWmFD63BndVYcCM0jvtWxXk3jdTVCAd.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/5114-q0V5URebphSG.jpg",
    "animeStudios": [
      "Bones",
      "bones",
      "Aniplex",
      "Square Enix",
      "Mainichi Broadcasting System",
      "Aniplex of America"
    ],
    "animeSeries": [
      "Fullmetal Alchemist"
    ],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 3890,
        "version": "NC+BD",
        "episodes": "1-14",
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC",
          "BD"
        ],
        "videoSources": [
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/FullmetalAlchemistBrotherhood-OP1.webm",
            "source": "BD",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/FullmetalAlchemistBrotherhood-OP1.webm",
        "audioUrl": "https://v.animethemes.moe/FullmetalAlchemistBrotherhood-OP1.webm",
        "duration": 90
      }
    ],
    "videoUrl": "https://v.animethemes.moe/FullmetalAlchemistBrotherhood-OP1.webm",
    "audioUrl": "https://v.animethemes.moe/FullmetalAlchemistBrotherhood-OP1.webm",
    "mood": [
      "nostalgic",
      "epic",
      "emotional"
    ],
    "avgRating": 10,
    "totalRatings": 2,
    "totalWatches": 3,
    "totalListens": 3,
    "duration": null,
    "isPopular": true,
    "popularRank": 3,
    "syncedAt": "2026-04-20T21:38:36.167Z",
    "createdAt": null,
    "updatedAt": "2026-04-27T12:24:31.715Z"
  },
  {
    "id": "69e5572196b4cfa3b8f89d41",
    "slug": "cowboy_bebop-op1-578",
    "animethemesId": 578,
    "anilistId": 1,
    "kitsuId": null,
    "songTitle": "Tank!",
    "animeTitle": "Cowboy Bebop",
    "animeTitleEnglish": "Cowboy Bebop",
    "animeTitleAlternative": [
      "カウボーイビバップ",
      "카우보이 비밥",
      "קאובוי ביבופ",
      "คาวบอย บีบ๊อป",
      "Ковбой Бибоп",
      "Καουμπόηδες του Διαστήματος",
      "Kowboj Bebop"
    ],
    "artistName": null,
    "allArtists": [],
    "artistSlugs": [],
    "artistRoles": [],
    "animeSeason": "SPRING",
    "animeSeasonYear": 1998,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/SfXyZUYbg7jNilXUhnQWoQl5oF2nFufNtHJrCap4.png",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/uoQrrZ8PdOLloLM3d0xUFJUR2dMpTQ0LC90eMWYG.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/1-OquNCNB6srGe.jpg",
    "animeStudios": [
      "Sunrise",
      "Bandai Visual",
      "Bandai Entertainment"
    ],
    "animeSeries": [
      "Cowboy Bebop"
    ],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 644,
        "version": "BD",
        "episodes": "1-25",
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "BD"
        ],
        "videoSources": [
          {
            "resolution": 720,
            "url": "https://v.animethemes.moe/CowboyBebop-OP1.webm",
            "source": "BD",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/CowboyBebop-OP1.webm",
        "audioUrl": "https://v.animethemes.moe/CowboyBebop-OP1.webm",
        "duration": 90
      }
    ],
    "videoUrl": "https://v.animethemes.moe/CowboyBebop-OP1.webm",
    "audioUrl": "https://v.animethemes.moe/CowboyBebop-OP1.webm",
    "mood": [
      "epic",
      "emotional"
    ],
    "avgRating": 0,
    "totalRatings": 0,
    "totalWatches": 1,
    "totalListens": 0,
    "duration": null,
    "isPopular": true,
    "popularRank": 4,
    "syncedAt": "2026-04-21T12:58:55.939Z",
    "createdAt": null,
    "updatedAt": "2026-04-27T12:24:33.674Z"
  },
  {
    "id": "69df91ea7a385727d1f6e890",
    "slug": "naruto_shippuuden-op16-2883",
    "animethemesId": 2883,
    "anilistId": 1735,
    "kitsuId": null,
    "songTitle": "Silhouette",
    "animeTitle": "Naruto: Shippuuden",
    "animeTitleEnglish": "Naruto: Shippuden",
    "animeTitleAlternative": [
      "NARUTO -ナルト- 疾風伝",
      "NARUTO: Shippuuden",
      "Naruto Shippuuden",
      "Naruto Shippuden",
      "נארוטו שיפודן",
      "火影忍者 疾风传",
      "นารูโตะ ตำนานวายุสลาตัน",
      "ناروتو شيبودن",
      "Наруто: Ураганные хроники"
    ],
    "artistName": "KANA-BOON",
    "allArtists": [
      "KANA-BOON"
    ],
    "artistSlugs": [
      "kana_boon"
    ],
    "artistRoles": [
      "performer"
    ],
    "animeSeason": "WINTER",
    "animeSeasonYear": 2007,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/RzZH6YW4N77UI4LIppb7vG39XRaJRMVHqVJvpX7z.png",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/NzuvEY9tfOb86g7rpOhnFUZH7aBo6ig8znAsgMLw.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/1735.jpg",
    "animeStudios": [
      "Pierrot",
      "Studio Pierrot",
      "TV Tokyo",
      "Aniplex",
      "KSS",
      "Viz Media",
      "Rakuonsha",
      "TV Tokyo Music"
    ],
    "animeSeries": [
      "Naruto"
    ],
    "type": "OP",
    "sequence": 16,
    "entries": [
      {
        "atEntryId": 3236,
        "version": "NC",
        "episodes": "380-405",
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC"
        ],
        "videoSources": [
          {
            "resolution": 576,
            "url": "https://v.animethemes.moe/NarutoShippuuden-OP16.webm",
            "source": "DVD",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/NarutoShippuuden-OP16.webm",
        "audioUrl": "https://v.animethemes.moe/NarutoShippuuden-OP16.webm",
        "duration": 90
      }
    ],
    "videoUrl": "https://v.animethemes.moe/NarutoShippuuden-OP16.webm",
    "audioUrl": "https://v.animethemes.moe/NarutoShippuuden-OP16.webm",
    "mood": [
      "epic",
      "upbeat",
      "emotional"
    ],
    "avgRating": 9,
    "totalRatings": 2,
    "totalWatches": 3,
    "totalListens": 0,
    "duration": null,
    "isPopular": true,
    "popularRank": 5,
    "syncedAt": "2026-04-20T22:06:58.322Z",
    "createdAt": "2026-04-15T13:26:02.786Z",
    "updatedAt": "2026-04-27T12:24:33.941Z"
  },
  {
    "id": "69df87077a385727d1f6b48f",
    "slug": "shingeki_no_kyojin-op1-5279",
    "animethemesId": 5279,
    "anilistId": 16498,
    "kitsuId": null,
    "songTitle": "Guren no Yumiya",
    "animeTitle": "Shingeki no Kyojin",
    "animeTitleEnglish": "Attack on Titan",
    "animeTitleAlternative": [
      "進撃の巨人",
      "SnK",
      "AoT",
      "Ataque a los Titanes",
      "Ataque dos Titãs",
      "L'Attacco dei Giganti",
      "מתקפת הטיטאנים",
      "进击的巨人",
      "L’Attaque des Titans",
      "الهجوم على العمالقة",
      "ผ่าพิภพไททัน",
      "حمله به تایتان",
      "Ataque de Titãs",
      "Atak Tytanów",
      "Атака титанов"
    ],
    "artistName": "Linked Horizon",
    "allArtists": [
      "Linked Horizon"
    ],
    "artistSlugs": [
      "linked_horizon"
    ],
    "artistRoles": [
      "performer"
    ],
    "animeSeason": "SPRING",
    "animeSeasonYear": 2013,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/mLoIEyGITkJPGCBxvjTpDyDYRM8rDb4ZuFGCKEaH.png",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/cUnunEwN4ktLVaEsSfRSgE7NREhfRMLGXKkkuDuS.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/16498-8jpFCOcDmneX.jpg",
    "animeStudios": [
      "WIT STUDIO",
      "Pony Canyon",
      "Kodansha",
      "Production I.G",
      "Dentsu",
      "Pony Canyon Enterprise",
      "Mainichi Broadcasting System"
    ],
    "animeSeries": [
      "Shingeki no Kyojin"
    ],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 6043,
        "version": "NC+BD",
        "episodes": "1-13",
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC",
          "BD"
        ],
        "videoSources": [
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/ShingekiNoKyojin-OP1.webm",
            "source": "BD",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/ShingekiNoKyojin-OP1.webm",
        "audioUrl": "https://v.animethemes.moe/ShingekiNoKyojin-OP1.webm",
        "duration": null
      }
    ],
    "videoUrl": "https://v.animethemes.moe/ShingekiNoKyojin-OP1.webm",
    "audioUrl": "https://v.animethemes.moe/ShingekiNoKyojin-OP1.webm",
    "mood": [
      "mysterious",
      "epic",
      "emotional"
    ],
    "avgRating": 0,
    "totalRatings": 0,
    "totalWatches": 2,
    "totalListens": 0,
    "duration": null,
    "isPopular": true,
    "popularRank": 6,
    "syncedAt": "2026-04-16T10:42:49.507Z",
    "createdAt": "2026-04-15T12:39:35.106Z",
    "updatedAt": "2026-04-27T12:24:34.134Z"
  },
  {
    "id": "69df884b7a385727d1f6b4c5",
    "slug": "one_punch_man-op1-6097",
    "animethemesId": 6097,
    "anilistId": 21087,
    "kitsuId": null,
    "songTitle": "THE HERO !! ~Okoreru Kobushi ni Hi wo Tsukero~",
    "animeTitle": "One Punch Man",
    "animeTitleEnglish": "One-Punch Man",
    "animeTitleAlternative": [
      "ワンパンマン",
      "OPM",
      "Wanpanman",
      "איש האגרוף הבודד",
      "一拳超人",
      "วันพันช์แมน",
      "Jagoan Sekali Pukul S1",
      "رجل اللكمة الواحدة",
      "ون بنش مان",
      "Ванпанчмен"
    ],
    "artistName": "JAM Project",
    "allArtists": [
      "JAM Project"
    ],
    "artistSlugs": [
      "jam_project"
    ],
    "artistRoles": [
      "performer"
    ],
    "animeSeason": "FALL",
    "animeSeasonYear": 2015,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/ZF8O9bo6HzfHdjT3wBPBLwHQgezVMYJtnl5k1NEO.png",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/MUZHeVkGyiXBeBbn2h673F4nOSBw6TLEukoYEWMQ.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/21087-sHb9zUZFsHe1.jpg",
    "animeStudios": [
      "Madhouse",
      "MADHOUSE",
      "TV Tokyo",
      "Bandai Visual",
      "Viz Media",
      "Lantis",
      "Shueisha",
      "Banpresto",
      "Asatsu DK",
      "Good Smile Company"
    ],
    "animeSeries": [
      "One Punch Man"
    ],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 7043,
        "version": "NC+BD",
        "episodes": "1-11",
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC",
          "BD"
        ],
        "videoSources": [
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/OnePunchMan-OP1.webm",
            "source": "BD",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/OnePunchMan-OP1.webm",
        "audioUrl": "https://v.animethemes.moe/OnePunchMan-OP1.webm",
        "duration": 90
      }
    ],
    "videoUrl": "https://v.animethemes.moe/OnePunchMan-OP1.webm",
    "audioUrl": "https://v.animethemes.moe/OnePunchMan-OP1.webm",
    "mood": [
      "epic",
      "upbeat"
    ],
    "avgRating": 9,
    "totalRatings": 1,
    "totalWatches": 3,
    "totalListens": 0,
    "duration": null,
    "isPopular": true,
    "popularRank": 7,
    "syncedAt": "2026-04-20T20:18:11.930Z",
    "createdAt": "2026-04-15T12:44:59.937Z",
    "updatedAt": "2026-04-27T12:24:34.286Z"
  },
  {
    "id": "69df879f7a385727d1f6b4b2",
    "slug": "jujutsu_kaisen-op1-9464",
    "animethemesId": 9464,
    "anilistId": 113415,
    "kitsuId": null,
    "songTitle": "Kaikai Kitan",
    "animeTitle": "Jujutsu Kaisen",
    "animeTitleEnglish": "JUJUTSU KAISEN",
    "animeTitleAlternative": [
      "呪術廻戦",
      "JJK",
      "Sorcery Fight",
      "咒术回战",
      "주술회전",
      "มหาเวทย์ผนึกมาร",
      "جوجوتسو كايسن",
      "Магическая битва",
      "咒術迴戰"
    ],
    "artistName": "Eve",
    "allArtists": [
      "Eve"
    ],
    "artistSlugs": [
      "eve"
    ],
    "artistRoles": [
      "performer"
    ],
    "animeSeason": "FALL",
    "animeSeasonYear": 2020,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/ggrh8wGLhZcYLtZskZD4h41Xh7Wxt735rdzygtRw.jpg",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/Q8KQ6VOQgaM10c6DdKVosASGUwYj5htmruZAEGYf.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/113415-jQBSkxWAAk83.jpg",
    "animeStudios": [
      "MAPPA",
      "Toho",
      "Shueisha",
      "Sumzap",
      "Mainichi Broadcasting System"
    ],
    "animeSeries": [
      "Jujutsu Kaisen"
    ],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 11128,
        "version": "NC+BD",
        "episodes": "1-2",
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC",
          "BD"
        ],
        "videoSources": [
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/JujutsuKaisen-OP1-NCBD1080.webm",
            "source": "BD",
            "mime": "video/webm"
          },
          {
            "resolution": 720,
            "url": "https://v.animethemes.moe/JujutsuKaisen-OP1.webm",
            "source": "WEB",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/JujutsuKaisen-OP1-NCBD1080.webm",
        "audioUrl": "https://v.animethemes.moe/JujutsuKaisen-OP1.webm",
        "duration": 90
      },
      {
        "atEntryId": 11129,
        "version": "NC+BD+V2",
        "episodes": "3-5",
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC",
          "BD",
          "V2"
        ],
        "videoSources": [
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/JujutsuKaisen-OP1v2-NCBD1080.webm",
            "source": "BD",
            "mime": "video/webm"
          },
          {
            "resolution": 720,
            "url": "https://v.animethemes.moe/JujutsuKaisen-OP1v2.webm",
            "source": "WEB",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/JujutsuKaisen-OP1v2-NCBD1080.webm",
        "audioUrl": "https://v.animethemes.moe/JujutsuKaisen-OP1v2.webm",
        "duration": 90
      },
      {
        "atEntryId": 11130,
        "version": "NC+BD+V3",
        "episodes": "6-7",
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC",
          "BD",
          "V3"
        ],
        "videoSources": [
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/JujutsuKaisen-OP1v3-NCBD1080.webm",
            "source": "BD",
            "mime": "video/webm"
          },
          {
            "resolution": 720,
            "url": "https://v.animethemes.moe/JujutsuKaisen-OP1v3.webm",
            "source": "WEB",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/JujutsuKaisen-OP1v3-NCBD1080.webm",
        "audioUrl": "https://v.animethemes.moe/JujutsuKaisen-OP1v3.webm",
        "duration": 90
      },
      {
        "atEntryId": 11131,
        "version": "NC+BD+V4",
        "episodes": "8-13",
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC",
          "BD",
          "V4"
        ],
        "videoSources": [
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/JujutsuKaisen-OP1v4-NCBD1080.webm",
            "source": "BD",
            "mime": "video/webm"
          },
          {
            "resolution": 720,
            "url": "https://v.animethemes.moe/JujutsuKaisen-OP1v4.webm",
            "source": "WEB",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/JujutsuKaisen-OP1v4-NCBD1080.webm",
        "audioUrl": "https://v.animethemes.moe/JujutsuKaisen-OP1v4.webm",
        "duration": 90
      }
    ],
    "videoUrl": "https://v.animethemes.moe/JujutsuKaisen-OP1-NCBD1080.webm",
    "audioUrl": "https://v.animethemes.moe/JujutsuKaisen-OP1.webm",
    "mood": [
      "epic",
      "emotional"
    ],
    "avgRating": 8.33,
    "totalRatings": 3,
    "totalWatches": 5,
    "totalListens": 1,
    "duration": null,
    "isPopular": true,
    "popularRank": 10,
    "syncedAt": "2026-04-20T12:07:07.532Z",
    "createdAt": "2026-04-15T12:42:06.995Z",
    "updatedAt": "2026-04-27T12:24:34.732Z"
  },
  {
    "id": "69e560cc96b4cfa3b8f89d7f",
    "slug": "rezero_kara_hajimeru_isekai_seikatsu_4th_season-op1-14329",
    "animethemesId": 14329,
    "anilistId": 189046,
    "kitsuId": "49746",
    "songTitle": "Recollect",
    "animeTitle": "Re:Zero kara Hajimeru Isekai Seikatsu 4th Season",
    "animeTitleEnglish": "Re:ZERO -Starting Life in Another World- Season 4",
    "animeTitleAlternative": [
      "Re:ZERO รีเซทชีวิต ฝ่าวิกฤตต่างโลก ซีซั่น 4"
    ],
    "artistName": "Konomi Suzuki",
    "allArtists": [
      "Konomi Suzuki",
      "Ashnikko"
    ],
    "artistSlugs": [
      "konomi_suzuki",
      "ashnikko"
    ],
    "artistRoles": [
      "performer",
      "performer"
    ],
    "animeSeason": "SPRING",
    "animeSeasonYear": 2026,
    "animeCoverImage": "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx189046-yaHWtS5FII46.jpg",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/MyvqAbdAClF2skyvlvxTazSYTEOP6yU9zYiV2Pnu.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/189046-MDk2CaVuRWpb.jpg",
    "animeStudios": [
      "White Fox",
      "KADOKAWA",
      "WHITE FOX",
      "Hakuhodo DY Music & Pictures",
      "AT-X",
      "DAXEL",
      "Memory-Tech"
    ],
    "animeSeries": [
      "Re:Zero kara Hajimeru Isekai Seikatsu"
    ],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 16760,
        "version": "NC+BD",
        "episodes": "2-3, 6, 8-9, 12",
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC",
          "BD"
        ],
        "videoSources": [
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/ReZeroS4-OP1-NCBD1080.webm",
            "source": "BD",
            "mime": "video/webm"
          },
          {
            "resolution": 720,
            "url": "https://v.animethemes.moe/ReZeroS4-OP1.webm",
            "source": "WEB",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/ReZeroS4-OP1-NCBD1080.webm",
        "audioUrl": "https://v.animethemes.moe/ReZeroS4-OP1.webm",
        "duration": 90
      }
    ],
    "videoUrl": "https://v.animethemes.moe/ReZeroS4-OP1-NCBD1080.webm",
    "audioUrl": "https://v.animethemes.moe/ReZeroS4-OP1.webm",
    "mood": [
      "romantic",
      "epic",
      "emotional"
    ],
    "avgRating": 0,
    "totalRatings": 0,
    "totalWatches": 0,
    "totalListens": 0,
    "duration": null,
    "isPopular": true,
    "popularRank": 11,
    "syncedAt": "2026-09-11T13:43:36.390Z",
    "createdAt": null,
    "updatedAt": "2026-09-11T13:43:36.390Z"
  },
  {
    "id": "69e5d67296b4cfa3b8f8a464",
    "slug": "yofukashi_no_uta_season_2-op1-13760",
    "animethemesId": 13760,
    "anilistId": 175914,
    "kitsuId": null,
    "songTitle": "Mirage",
    "animeTitle": "Yofukashi no Uta Season 2",
    "animeTitleEnglish": "Call of the Night Season 2",
    "animeTitleAlternative": [
      "よふかしのうた Season 2"
    ],
    "artistName": "Creepy Nuts",
    "allArtists": [
      "Creepy Nuts"
    ],
    "artistSlugs": [
      "creepy_nuts"
    ],
    "artistRoles": [
      "performer"
    ],
    "animeSeason": "SUMMER",
    "animeSeasonYear": 2025,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/40nACKbR2leEMdpxDhBqRSbKTgr4mywkBXgUSxIt.jpg",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/dNhquUO0KdLQlDJ2edrtBdqbqzSzCCLFsdb3kB0t.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/175914-K0Hw6bg3Tf5i.jpg",
    "animeStudios": [
      "LIDENFILMS",
      "Fuji TV",
      "Aniplex",
      "Shogakukan",
      "Shogakukan-Shueisha Productions",
      "Ultra Super Pictures",
      "Tohan",
      "Animax Broadcast Japan",
      "Dentsu",
      "Fuji Creative Corporation"
    ],
    "animeSeries": [
      "Yofukashi no Uta"
    ],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 16151,
        "version": "Standard",
        "episodes": "1-",
        "spoiler": false,
        "nsfw": false,
        "tags": [],
        "videoSources": [
          {
            "resolution": 720,
            "url": "https://v.animethemes.moe/YofukashiNoUtaS2-OP1.webm",
            "source": "WEB",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/YofukashiNoUtaS2-OP1.webm",
        "audioUrl": "https://v.animethemes.moe/YofukashiNoUtaS2-OP1.webm",
        "duration": null
      }
    ],
    "videoUrl": "https://v.animethemes.moe/YofukashiNoUtaS2-OP1.webm",
    "audioUrl": "https://v.animethemes.moe/YofukashiNoUtaS2-OP1.webm",
    "mood": [
      "romantic",
      "calm",
      "upbeat"
    ],
    "avgRating": 0,
    "totalRatings": 0,
    "totalWatches": 0,
    "totalListens": 0,
    "duration": null,
    "isPopular": true,
    "popularRank": 12,
    "syncedAt": "2026-04-20T07:31:59.948Z",
    "createdAt": null,
    "updatedAt": "2026-04-27T12:24:35.037Z"
  },
  {
    "id": "69df83977a385727d1f6b3cb",
    "slug": "ore_dake_level_up_na_ken_season_2_arise_from_the_shadow-op1-13369",
    "animethemesId": 13369,
    "anilistId": 176496,
    "kitsuId": null,
    "songTitle": "ReawakeR (feat. Felix of Stray Kids)",
    "animeTitle": "Ore dake Level Up na Ken Season 2: Arise from the Shadow",
    "animeTitleEnglish": "Solo Leveling Season 2 -Arise from the Shadow-",
    "animeTitleAlternative": [
      "俺だけレベルアップな件 Season 2 -Arise from the Shadow-",
      "Ore dake Level Up na Ken: Season 2 - Arise from the Shadow",
      "Na Honjaman Level Up 2",
      "나 혼자만 레벨업 2",
      "俺だけレベルアップな件 第2期",
      "Ore dake Level Up na Ken 2nd Season",
      "Solo Leveling 2ª Temporada -Ergam-se das Sombras-",
      "나 혼자만 레벨업 -ARISE FROM THE SHADOW-"
    ],
    "artistName": "LiSA",
    "allArtists": [
      "LiSA",
      "Felix"
    ],
    "artistSlugs": [
      "lisa",
      "felix"
    ],
    "artistRoles": [
      "performer",
      "performer"
    ],
    "animeSeason": "WINTER",
    "animeSeasonYear": 2025,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/EpbBzi0JgX3nx33ztRldeUOoB7THHGJr9mizquya.png",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/ce3tz2qN6tlE3QH2SAKU759jj6K1nXE3RzEGJcFQ.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/176496-5oY4k2NRqlYs.jpg",
    "animeStudios": [
      "A-1 Pictures",
      "Aniplex",
      "Netmarble",
      "D&C MEDIA",
      "Kakao piccoma",
      "Crunchyroll"
    ],
    "animeSeries": [
      "Ore dake Level Up na Ken"
    ],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 15642,
        "version": "Standard",
        "episodes": "1-11, 13",
        "spoiler": false,
        "nsfw": false,
        "tags": [],
        "videoSources": [
          {
            "resolution": 720,
            "url": "https://v.animethemes.moe/SoloLevelingS2-OP1.webm",
            "source": "WEB",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/SoloLevelingS2-OP1.webm",
        "audioUrl": "https://v.animethemes.moe/SoloLevelingS2-OP1.webm",
        "duration": 90
      }
    ],
    "videoUrl": "https://v.animethemes.moe/SoloLevelingS2-OP1.webm",
    "audioUrl": "https://v.animethemes.moe/SoloLevelingS2-OP1.webm",
    "mood": [
      "epic",
      "dark"
    ],
    "avgRating": 0,
    "totalRatings": 0,
    "totalWatches": 1,
    "totalListens": 0,
    "duration": null,
    "isPopular": true,
    "popularRank": 13,
    "syncedAt": "2026-09-04T09:12:00.452Z",
    "createdAt": "2026-04-15T12:24:55.524Z",
    "updatedAt": "2026-09-04T09:12:02.927Z"
  },
  {
    "id": "69df8ceb7a385727d1f6b5d4",
    "slug": "witch_watch-op1-13595",
    "animethemesId": 13595,
    "anilistId": 180367,
    "kitsuId": null,
    "songTitle": "Watch me!",
    "animeTitle": "Witch Watch",
    "animeTitleEnglish": "WITCH WATCH",
    "animeTitleAlternative": [
      "ウィッチウォッチ"
    ],
    "artistName": "YOASOBI",
    "allArtists": [
      "YOASOBI"
    ],
    "artistSlugs": [
      "yoasobi"
    ],
    "artistRoles": [
      "performer"
    ],
    "animeSeason": "SPRING",
    "animeSeasonYear": 2025,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/Uahh45QfWVwHF9XU7Ebj7Ld3Ty5yVlVWcURO1otC.jpg",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/YDUJLTMokSi7M7ygWpiu5rTFEYT2yV0ckaF8CG8c.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/180367-Kpxveeh3Q3cm.jpg",
    "animeStudios": [
      "Bibury Animation Studios",
      "Mainichi Broadcasting System",
      "AQUA ARIS",
      "JR Higashi Nihon Kikaku",
      "Shueisha",
      "Movic",
      "Shogakukan-Shueisha Productions",
      "Shouchiku"
    ],
    "animeSeries": [],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 15905,
        "version": "NC+BD",
        "episodes": "1-2, 4-10, 12",
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC",
          "BD"
        ],
        "videoSources": [
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/WitchWatch-OP1-NCBD1080.webm",
            "source": "BD",
            "mime": "video/webm"
          },
          {
            "resolution": 720,
            "url": "https://v.animethemes.moe/WitchWatch-OP1.webm",
            "source": "WEB",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/WitchWatch-OP1-NCBD1080.webm",
        "audioUrl": "https://v.animethemes.moe/WitchWatch-OP1.webm",
        "duration": null
      },
      {
        "atEntryId": 15981,
        "version": "NC+BD+V2",
        "episodes": "3",
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC",
          "BD",
          "V2"
        ],
        "videoSources": [
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/WitchWatch-OP1v2-NCBD1080.webm",
            "source": "BD",
            "mime": "video/webm"
          },
          {
            "resolution": 720,
            "url": "https://v.animethemes.moe/WitchWatch-OP1v2.webm",
            "source": "WEB",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/WitchWatch-OP1v2-NCBD1080.webm",
        "audioUrl": "https://v.animethemes.moe/WitchWatch-OP1v2.webm",
        "duration": null
      }
    ],
    "videoUrl": "https://v.animethemes.moe/WitchWatch-OP1-NCBD1080.webm",
    "audioUrl": "https://v.animethemes.moe/WitchWatch-OP1.webm",
    "mood": [
      "romantic",
      "calm",
      "upbeat",
      "emotional"
    ],
    "avgRating": 0,
    "totalRatings": 0,
    "totalWatches": 0,
    "totalListens": 0,
    "duration": null,
    "isPopular": true,
    "popularRank": 14,
    "syncedAt": "2026-04-15T13:04:40.943Z",
    "createdAt": "2026-04-15T13:04:43.277Z",
    "updatedAt": "2026-04-27T12:24:35.336Z"
  },
  {
    "id": "69e5572d96b4cfa3b8f89d42",
    "slug": "gachiakuta-op1-13845",
    "animethemesId": 13845,
    "anilistId": 178025,
    "kitsuId": null,
    "songTitle": "HUGs",
    "animeTitle": "Gachiakuta",
    "animeTitleEnglish": "Gachiakuta",
    "animeTitleAlternative": [
      "ガチアクタ",
      "Гачиакута"
    ],
    "artistName": null,
    "allArtists": [],
    "artistSlugs": [],
    "artistRoles": [],
    "animeSeason": "SUMMER",
    "animeSeasonYear": 2025,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/ZrJ2ftit5NT4h0DNiO8H7OTxodHGnATrPifwP3c8.jpg",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/dBeTayyhVOwCAYdqfaqocdSJjI9IuyxdRL5LxCo4.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/178025-WvcXi1J2SGRa.jpg",
    "animeStudios": [
      "bones",
      "Avex Pictures",
      "bones film",
      "Kodansha",
      "DMM.com",
      "CBC TV",
      "Dentsu",
      "Com2uS"
    ],
    "animeSeries": [],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 16237,
        "version": "Standard",
        "episodes": "1-13",
        "spoiler": false,
        "nsfw": false,
        "tags": [],
        "videoSources": [
          {
            "resolution": 720,
            "url": "https://v.animethemes.moe/Gachiakuta-OP1.webm",
            "source": "WEB",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/Gachiakuta-OP1.webm",
        "audioUrl": "https://v.animethemes.moe/Gachiakuta-OP1.webm",
        "duration": null
      }
    ],
    "videoUrl": "https://v.animethemes.moe/Gachiakuta-OP1.webm",
    "audioUrl": "https://v.animethemes.moe/Gachiakuta-OP1.webm",
    "mood": [
      "epic",
      "emotional"
    ],
    "avgRating": 0,
    "totalRatings": 0,
    "totalWatches": 1,
    "totalListens": 3,
    "duration": null,
    "isPopular": true,
    "popularRank": 15,
    "syncedAt": "2026-04-19T22:28:58.821Z",
    "createdAt": null,
    "updatedAt": "2026-09-05T10:19:20.246Z"
  },
  {
    "id": "69df26ed7a385727d1f6b237",
    "slug": "chainsaw_man-op1-11849",
    "animethemesId": 11849,
    "anilistId": 127230,
    "kitsuId": null,
    "songTitle": "KICK BACK",
    "animeTitle": "Chainsaw Man",
    "animeTitleEnglish": "Chainsaw Man",
    "animeTitleAlternative": [
      "チェンソーマン",
      "CSM",
      "رجل المنشار",
      "链锯人",
      "Человек-бензопила",
      "체인소 맨"
    ],
    "artistName": "Kenshi Yonezu",
    "allArtists": [
      "Kenshi Yonezu"
    ],
    "artistSlugs": [
      "kenshi_yonezu"
    ],
    "artistRoles": [
      "performer"
    ],
    "animeSeason": "FALL",
    "animeSeasonYear": 2022,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/I56a7g5t4kDpD2lIh8GeavpQbT7GxTXbcbjOSoDb.png",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/FvQdGZio8WuqIzNe9nvEAZLlCIcx1N0r1xaoYnYM.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/127230-o8IRwCGVr9KW.jpg",
    "animeStudios": [
      "MAPPA",
      "Shueisha"
    ],
    "animeSeries": [
      "Chainsaw Man"
    ],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 13782,
        "version": "NC+BD",
        "episodes": "1-12",
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC",
          "BD"
        ],
        "videoSources": [
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/ChainsawMan-OP1-NCBD1080.webm",
            "source": "BD",
            "mime": "video/webm"
          },
          {
            "resolution": 720,
            "url": "https://v.animethemes.moe/ChainsawMan-OP1.webm",
            "source": "WEB",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/ChainsawMan-OP1-NCBD1080.webm",
        "audioUrl": "https://v.animethemes.moe/ChainsawMan-OP1.webm",
        "duration": 90
      }
    ],
    "videoUrl": "https://v.animethemes.moe/ChainsawMan-OP1-NCBD1080.webm",
    "audioUrl": "https://v.animethemes.moe/ChainsawMan-OP1.webm",
    "mood": [
      "dark",
      "epic",
      "emotional"
    ],
    "avgRating": 7,
    "totalRatings": 1,
    "totalWatches": 2,
    "totalListens": 0,
    "duration": null,
    "isPopular": true,
    "popularRank": 17,
    "syncedAt": "2026-04-20T17:30:44.444Z",
    "createdAt": "2026-04-15T05:49:33.252Z",
    "updatedAt": "2026-04-27T12:24:35.779Z"
  },
  {
    "id": "69df218f7a385727d1f6aeb8",
    "slug": "shingeki_no_kyojin_the_final_season_part_2-op1-11077",
    "animethemesId": 11077,
    "anilistId": 131681,
    "kitsuId": null,
    "songTitle": "The Rumbling",
    "animeTitle": "Shingeki no Kyojin: The Final Season Part 2",
    "animeTitleEnglish": "Attack on Titan Final Season Part 2",
    "animeTitleAlternative": [
      "進撃の巨人 The Final Season Part 2",
      "SnK 4",
      "AoT 4",
      "L'attaque des titans Saison Finale Partie 2",
      "Shingeki no Kyojin: The Final Season (2022)",
      "اتک عن تایتان",
      "حمله به غول ها",
      "حمله به تایتان فصل 4 ",
      " ผ่าพิภพไททัน ไฟนอล ซีซั่น Part 2",
      "ผ่าพิภพไททัน ภาค 4",
      "L'Attacco dei Giganti 4 Parte 2",
      "Атака титанов: Финал. Часть 2"
    ],
    "artistName": "SiM",
    "allArtists": [
      "SiM"
    ],
    "artistSlugs": [
      "sim"
    ],
    "artistRoles": [
      "performer"
    ],
    "animeSeason": "WINTER",
    "animeSeasonYear": 2022,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/fiGgK0RR0jQ7hE1sgxVEwYVkbWFffNgii0fs9bz2.jpg",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/L18hbFqVj47VjSqfKe6pWFvqHit5nIssUYRC18r6.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/131681-3tNurPRsqsfz.jpg",
    "animeStudios": [
      "MAPPA",
      "Pony Canyon",
      "Kodansha",
      "Production I.G",
      "Dentsu",
      "Mainichi Broadcasting System",
      "Pony Canyon Enterprise"
    ],
    "animeSeries": [
      "Shingeki no Kyojin"
    ],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 12899,
        "version": "Standard",
        "episodes": "1-8, 10-11",
        "spoiler": false,
        "nsfw": false,
        "tags": [],
        "videoSources": [
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/ShingekiNoKyojinS4Part2-OP1.webm",
            "source": "WEB",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/ShingekiNoKyojinS4Part2-OP1.webm",
        "audioUrl": "https://v.animethemes.moe/ShingekiNoKyojinS4Part2-OP1.webm",
        "duration": 90
      }
    ],
    "videoUrl": "https://v.animethemes.moe/ShingekiNoKyojinS4Part2-OP1.webm",
    "audioUrl": "https://v.animethemes.moe/ShingekiNoKyojinS4Part2-OP1.webm",
    "mood": [
      "mysterious",
      "epic",
      "emotional"
    ],
    "avgRating": 0,
    "totalRatings": 0,
    "totalWatches": 0,
    "totalListens": 0,
    "duration": null,
    "isPopular": true,
    "popularRank": 18,
    "syncedAt": "2026-04-20T11:14:12.473Z",
    "createdAt": "2026-04-15T05:26:38.999Z",
    "updatedAt": "2026-04-27T12:24:35.941Z"
  },
  {
    "id": "69e560e196b4cfa3b8f89d80",
    "slug": "dorohedoro_season_2-op1-14297",
    "animethemesId": 14297,
    "anilistId": 173172,
    "kitsuId": "48410",
    "songTitle": "Zettai MUST Danmen",
    "animeTitle": "Dorohedoro Season 2",
    "animeTitleEnglish": "Dorohedoro Season 2",
    "animeTitleAlternative": [
      "Дорохедоро 2",
      "สาปพันธุ์อสูร ซีซั่น2"
    ],
    "artistName": "(K)NoW_NAME",
    "allArtists": [
      "(K)NoW_NAME"
    ],
    "artistSlugs": [
      "know_name"
    ],
    "artistRoles": [
      "performer"
    ],
    "animeSeason": "SPRING",
    "animeSeasonYear": 2026,
    "animeCoverImage": "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx173172-404XnuOS0DhR.jpg",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/zZDJEZPd8NZoSN4hXt26WXqSham3MQT67nAhyOQv.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/173172-tkPQqLzfnxYN.jpg",
    "animeStudios": [
      "MAPPA",
      "Toho"
    ],
    "animeSeries": [
      "Dorohedoro"
    ],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 16727,
        "version": "Standard",
        "episodes": "1-",
        "spoiler": false,
        "nsfw": false,
        "tags": [],
        "videoSources": [
          {
            "resolution": 720,
            "url": "https://v.animethemes.moe/DorohedoroS2-OP1.webm",
            "source": "WEB",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/DorohedoroS2-OP1.webm",
        "audioUrl": "https://v.animethemes.moe/DorohedoroS2-OP1.webm",
        "duration": 90
      }
    ],
    "videoUrl": "https://v.animethemes.moe/DorohedoroS2-OP1.webm",
    "audioUrl": "https://v.animethemes.moe/DorohedoroS2-OP1.webm",
    "mood": [
      "mysterious",
      "dark",
      "epic",
      "upbeat"
    ],
    "avgRating": 0,
    "totalRatings": 0,
    "totalWatches": 0,
    "totalListens": 0,
    "duration": null,
    "isPopular": true,
    "popularRank": 20,
    "syncedAt": "2026-09-11T13:43:26.371Z",
    "createdAt": null,
    "updatedAt": "2026-09-11T13:43:26.371Z"
  },
  {
    "id": "69df13fb7a385727d1f6ab86",
    "slug": "jujutsu_kaisen_2nd_season-op2-12461",
    "animethemesId": 12461,
    "anilistId": 145064,
    "kitsuId": null,
    "songTitle": "SPECIALZ",
    "animeTitle": "Jujutsu Kaisen 2nd Season",
    "animeTitleEnglish": "JUJUTSU KAISEN Season 2",
    "animeTitleAlternative": [
      "呪術廻戦 第2期",
      "呪術廻戦 懐玉・玉折／渋谷事変 ",
      "Jujutsu Kaisen: Kaigyoku Gyokusetsu / Shibuya Jihen",
      "Jujutsu Kaisen: Hidden Inventory / Premature Death",
      "JJK2",
      "咒術迴戰  第二季",
      "มหาเวทย์ผนึกมาร ภาค 2 ",
      "咒术回战 2",
      "2جوجوتسو كايسن ",
      "Jujutsu Kaisen: Shibuya Incident"
    ],
    "artistName": "King Gnu",
    "allArtists": [
      "King Gnu"
    ],
    "artistSlugs": [
      "king_gnu"
    ],
    "artistRoles": [
      "performer"
    ],
    "animeSeason": "SUMMER",
    "animeSeasonYear": 2023,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/cJED2tzLpk4nKIL3lbb4zElDnwDQKEUbizSuAFay.jpg",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/IcTCsNYO8MH0gsM9jeZ6NDs6RI2fpoKNVhrj0Lrd.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/145064-esDtAY2He7sk.jpg",
    "animeStudios": [
      "MAPPA",
      "Toho",
      "Shueisha",
      "Sumzap",
      "Mainichi Broadcasting System"
    ],
    "animeSeries": [
      "Jujutsu Kaisen"
    ],
    "type": "OP",
    "sequence": 2,
    "entries": [
      {
        "atEntryId": 14573,
        "version": "NC+BD",
        "episodes": "6-16, 18-19",
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC",
          "BD"
        ],
        "videoSources": [
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/JujutsuKaisenS2-OP2-NCBD1080.webm",
            "source": "BD",
            "mime": "video/webm"
          },
          {
            "resolution": 720,
            "url": "https://v.animethemes.moe/JujutsuKaisenS2-OP2.webm",
            "source": "WEB",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/JujutsuKaisenS2-OP2-NCBD1080.webm",
        "audioUrl": "https://v.animethemes.moe/JujutsuKaisenS2-OP2.webm",
        "duration": 90
      },
      {
        "atEntryId": 14786,
        "version": "V2",
        "episodes": "20-22",
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "V2"
        ],
        "videoSources": [
          {
            "resolution": 720,
            "url": "https://v.animethemes.moe/JujutsuKaisenS2-OP2v2.webm",
            "source": "WEB",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/JujutsuKaisenS2-OP2v2.webm",
        "audioUrl": "https://v.animethemes.moe/JujutsuKaisenS2-OP2v2.webm",
        "duration": 90
      },
      {
        "atEntryId": 14934,
        "version": "V3",
        "episodes": "23",
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "V3"
        ],
        "videoSources": [
          {
            "resolution": 720,
            "url": "https://v.animethemes.moe/JujutsuKaisenS2-OP2v3.webm",
            "source": "WEB",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/JujutsuKaisenS2-OP2v3.webm",
        "audioUrl": "https://v.animethemes.moe/JujutsuKaisenS2-OP2v3.webm",
        "duration": 90
      }
    ],
    "videoUrl": "https://v.animethemes.moe/JujutsuKaisenS2-OP2-NCBD1080.webm",
    "audioUrl": "https://v.animethemes.moe/JujutsuKaisenS2-OP2.webm",
    "mood": [
      "epic",
      "emotional"
    ],
    "avgRating": 9,
    "totalRatings": 1,
    "totalWatches": 1,
    "totalListens": 1,
    "duration": null,
    "isPopular": true,
    "popularRank": 21,
    "syncedAt": "2026-04-20T12:38:42.185Z",
    "createdAt": "2026-04-15T04:28:43.031Z",
    "updatedAt": "2026-04-27T12:24:36.388Z"
  },
  {
    "id": "69df0fca7a385727d1f6aaf0",
    "slug": "oshi_no_ko-op1-12293",
    "animethemesId": 12293,
    "anilistId": null,
    "kitsuId": "46170",
    "songTitle": "Idol",
    "animeTitle": "[Oshi no Ko]",
    "animeTitleEnglish": "Oshi no Ko",
    "animeTitleAlternative": [
      "【推しの子】"
    ],
    "artistName": "YOASOBI",
    "allArtists": [
      "YOASOBI"
    ],
    "artistSlugs": [
      "yoasobi"
    ],
    "artistRoles": [
      "performer"
    ],
    "animeSeason": "SPRING",
    "animeSeasonYear": 2023,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/KZ2cO6LbgXo2oevDokEfaaPxxUt9uL6989SL3DxD.png",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/GsYz0cxr0jfHwRrZ1Oj71w103AbYZ1uYWwBaaRQ2.avif",
    "animeGrillImage": "https://media.kitsu.app/anime/46170/cover_image/large-49585dba0b824dbd0267d5c7ce8ef56f.jpeg",
    "animeStudios": [
      "Doga Kobo"
    ],
    "animeSeries": [
      "[Oshi no Ko]"
    ],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 14356,
        "version": "NC+BD",
        "episodes": "1-11",
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC",
          "BD"
        ],
        "videoSources": [
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/OshiNoKo-OP1-NCBD1080.webm",
            "source": "BD",
            "mime": "video/webm"
          },
          {
            "resolution": 720,
            "url": "https://v.animethemes.moe/OshiNoKo-OP1.webm",
            "source": "WEB",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/OshiNoKo-OP1-NCBD1080.webm",
        "audioUrl": "https://v.animethemes.moe/OshiNoKo-OP1.webm",
        "duration": 90
      }
    ],
    "videoUrl": "https://v.animethemes.moe/OshiNoKo-OP1-NCBD1080.webm",
    "audioUrl": "https://v.animethemes.moe/OshiNoKo-OP1.webm",
    "mood": [],
    "avgRating": 0,
    "totalRatings": 0,
    "totalWatches": 0,
    "totalListens": 0,
    "duration": null,
    "isPopular": true,
    "popularRank": 24,
    "syncedAt": "2026-04-20T12:13:54.808Z",
    "createdAt": "2026-04-15T04:10:50.788Z",
    "updatedAt": "2026-04-27T12:24:36.845Z"
  },
  {
    "id": "69e664f596b4cfa3b8f8ba9b",
    "slug": "ryuu_to_sobakasu_no_hime-op1-13108",
    "animethemesId": 13108,
    "anilistId": 127271,
    "kitsuId": null,
    "songTitle": "U",
    "animeTitle": "Ryuu to Sobakasu no Hime",
    "animeTitleEnglish": "BELLE",
    "animeTitleAlternative": [
      "竜とそばかすの姫",
      "The Dragon and Freckled Princess",
      "BELLE เจ้าหญิงแห่งเสียงเพลง",
      "Красавица и дракон",
      "Μπελ: Ο Δράκος και Η Πριγκίπισσα",
      "龙与雀斑公主",
      "Дракон та веснянкувата принцеса",
      "Belle: The Dragon and the Freckled Princess",
      "Skaistule un briesmonis",
      "Сұлу қыз бен айдаһар",
      "Gözəl və əjdaha"
    ],
    "artistName": "millennium parade",
    "allArtists": [
      "millennium parade",
      "Kaho Nakamura"
    ],
    "artistSlugs": [
      "millennium_parade",
      "kaho_nakamura"
    ],
    "artistRoles": [
      "performer",
      "performer"
    ],
    "animeSeason": "SUMMER",
    "animeSeasonYear": 2021,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/27JVbyglQp4fMYRQhKXzXhMdrOyMqlDUcUoUmqJl.png",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/QwcGl8NmybiQkh62wRljWK1RQBsJGBlz3gLjRzEM.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/127271-PYK1XpL5Ha90.jpg",
    "animeStudios": [
      "Studio Chizu",
      "Cartoon Saloon"
    ],
    "animeSeries": [],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 15322,
        "version": "NC+BD",
        "episodes": null,
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC",
          "BD"
        ],
        "videoSources": [
          {
            "resolution": 800,
            "url": "https://v.animethemes.moe/RyuuToSobakasuNoHime-OP1.webm",
            "source": "BD",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/RyuuToSobakasuNoHime-OP1.webm",
        "audioUrl": "https://v.animethemes.moe/RyuuToSobakasuNoHime-OP1.webm",
        "duration": 90
      }
    ],
    "videoUrl": "https://v.animethemes.moe/RyuuToSobakasuNoHime-OP1.webm",
    "audioUrl": "https://v.animethemes.moe/RyuuToSobakasuNoHime-OP1.webm",
    "mood": [
      "mysterious",
      "emotional"
    ],
    "avgRating": 0,
    "totalRatings": 0,
    "totalWatches": 0,
    "totalListens": 0,
    "duration": 90,
    "isPopular": true,
    "popularRank": 25,
    "syncedAt": "2026-04-20T17:40:00.797Z",
    "createdAt": "2026-04-20T17:40:03.371Z",
    "updatedAt": "2026-04-27T12:24:36.992Z"
  },
  {
    "id": "69df88147a385727d1f6b4bf",
    "slug": "boku_no_hero_academia-op1-6972",
    "animethemesId": 6972,
    "anilistId": 21459,
    "kitsuId": null,
    "songTitle": "The Day",
    "animeTitle": "Boku no Hero Academia",
    "animeTitleEnglish": "My Hero Academia",
    "animeTitleAlternative": [
      "僕のヒーローアカデミア",
      "BNHA",
      "MHA",
      "나의 히어로 아카데미아 1기",
      "나히아 1기",
      "אקדמיית הגיבורים שלי",
      "我的英雄学院",
      "มายฮีโร่ อคาเดเมีย",
      "أكاديميتي للأبطال",
      "Η Δική Μου Ακαδημία Ηρώων ",
      "Akademia bohaterów ",
      "Моя геройская академия"
    ],
    "artistName": "Porno Graffitti",
    "allArtists": [
      "Porno Graffitti"
    ],
    "artistSlugs": [
      "porno_graffitti"
    ],
    "artistRoles": [
      "performer"
    ],
    "animeSeason": "SPRING",
    "animeSeasonYear": 2016,
    "animeCoverImage": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/large-cover/ddPmvU8eKAtzdm0Pxw93fXzjrtfeS7NarOMiTety.jpg",
    "animeCoverImageSmall": "https://pub-92474f7785774e91a790e086dfa6b2ef.r2.dev/anime/small-cover/gl9b6hyGHR6wLZe1wAc73dV6tniB1WEvYR8S2Gj7.avif",
    "animeGrillImage": "https://s4.anilist.co/file/anilistcdn/media/anime/banner/21459-yeVkolGKdGUV.jpg",
    "animeStudios": [
      "Bones",
      "bones",
      "Dentsu",
      "Mainichi Broadcasting System",
      "Toho",
      "Movic"
    ],
    "animeSeries": [
      "Boku no Hero Academia"
    ],
    "type": "OP",
    "sequence": 1,
    "entries": [
      {
        "atEntryId": 8092,
        "version": "NC+BD",
        "episodes": null,
        "spoiler": false,
        "nsfw": false,
        "tags": [
          "NC",
          "BD"
        ],
        "videoSources": [
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/BokuNoHeroAcademia-OP1-NCBD1080.webm",
            "source": "BD",
            "mime": "video/webm"
          },
          {
            "resolution": 1080,
            "url": "https://v.animethemes.moe/BokuNoHeroAcademia-OP1.webm",
            "source": "BD",
            "mime": "video/webm"
          }
        ],
        "videoUrl": "https://v.animethemes.moe/BokuNoHeroAcademia-OP1-NCBD1080.webm",
        "audioUrl": "https://v.animethemes.moe/BokuNoHeroAcademia-OP1.webm",
        "duration": 90
      }
    ],
    "videoUrl": "https://v.animethemes.moe/BokuNoHeroAcademia-OP1-NCBD1080.webm",
    "audioUrl": "https://v.animethemes.moe/BokuNoHeroAcademia-OP1.webm",
    "mood": [
      "epic",
      "upbeat"
    ],
    "avgRating": 0,
    "totalRatings": 0,
    "totalWatches": 0,
    "totalListens": 0,
    "duration": null,
    "isPopular": true,
    "popularRank": 26,
    "syncedAt": "2026-04-20T19:49:29.330Z",
    "createdAt": "2026-04-15T12:44:03.984Z",
    "updatedAt": "2026-04-27T12:24:37.188Z"
  }
];
