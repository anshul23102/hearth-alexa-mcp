# Gallery images

The images uploaded to the Devpost gallery and used in the README. They are real screenshots of the running app (synthetic order data,
real recall notices), framed on an exact 3:2 canvas in the app's own cobalt with a caption. `5-measured.png` is a slide whose numbers come
from [../SCALE.md](../SCALE.md), `npm run eval`, and the test and finding counts read from the repo. `thumbnail.png` is the pushed-alert shot.

Regenerate all of them (needs Google Chrome; starts a throwaway server and drives the real simulator in headless Chrome):

```bash
npm run gallery
```
