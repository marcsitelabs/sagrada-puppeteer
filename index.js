const puppeteer = require('puppeteer');
const { Storage } = require('@google-cloud/storage');

const storage = new Storage();
const bucketName = 'safa-ava'; // Replace with your actual bucket name

exports.productads = async (req, res) => {
    console.log("🚀 Starting Puppeteer script...");

    try {
        console.log("🔧 Launching browser...");
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1500, height: 1300 });

        console.log("🌍 Navigating to ticket page...");
        await page.goto('https://tickets.sagradafamilia.org/ca/1-individual/4375-sagrada-familia');
        await page.waitForSelector('table.CalendarMonth_table.CalendarMonth_table_1', { timeout: 10000 });

        let results = [];
        let monthCount = 0;

        const extractAvailableDates = async () => {
            console.log("🔍 Extracting available dates...");
            return await page.evaluate(() => {
                let monthDiv = document.querySelector('.CalendarMonth[data-visible="true"]');
                if (!monthDiv) return [];
                return Array.from(monthDiv.querySelectorAll('.CalendarDay_button'))
                    .filter(button => {
                        let parent = button.closest('[role="button"]');
                        return parent && !parent.getAttribute('aria-label')?.includes("Not available");
                    })
                    .map(button => button.getAttribute('data-date-id'));
            });
        };

        const extractEventsTabs = async () => {
            console.log("📜 Extracting available time slots...");
            return await page.evaluate(() => {
                let eventSelectors = document.querySelectorAll('.events-tabs .event-selector .event .date span');
                return eventSelectors.length > 0 ? Array.from(eventSelectors).map(el => el.innerText.trim()) : [];
            });
        };

        const clickCanviarButton = async () => {
            console.log("🔄 Checking if 'Canviar' button is available...");
            let canviarButton = await page.$('div.edit.clickable.border-round[title="Canviar"]');
            if (canviarButton) {
                console.log("🖱 Clicking 'Canviar' button...");
                await canviarButton.click();
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                console.log("⚠️ 'Canviar' button not found, skipping.");
            }
        };

        const clickEventTimesAndExtract = async (date) => {
            console.log(`🕒 Extracting event times for date: ${date}...`);
            let allAvailableTimes = [];

            let eventSelectors = await page.$$('.event-group-tabs .event-selector .event .date');
            if (eventSelectors.length === 0) {
                console.log("⚠️ No event times found initially. Retrying in 2 seconds...");
                await new Promise(resolve => setTimeout(resolve, 2000));
                eventSelectors = await page.$$('.event-group-tabs .event-selector .event .date');
                if (eventSelectors.length === 0) {
                    console.log("❌ No event times found after retry.");
                    return [];
                }
            }

            for (let i = 0; i < eventSelectors.length; i++) {
                try {
                    let eventTimes = await page.evaluate(el => el.innerText.trim(), eventSelectors[i]);
                    console.log(`🖱 Clicking event time slot: ${eventTimes}`);

                    let freshEventSelector = await page.$$('.event-group-tabs .event-selector .event .date');
                    if (!freshEventSelector[i]) {
                        console.log(`⚠️ Event time element detached, retrying click for ${eventTimes}...`);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        freshEventSelector = await page.$$('.event-group-tabs .event-selector .event .date');
                    }

                    if (freshEventSelector[i]) {
                        await freshEventSelector[i].click();
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    } else {
                        console.log(`⚠️ Skipping ${eventTimes}, element still detached.`);
                        continue;
                    }

                    let extractedTimes = await extractEventsTabs();
                    console.log(`📌 Found times for ${eventTimes}: ${extractedTimes.join(", ")}`);

                    if (extractedTimes.length > 0) {
                        allAvailableTimes.push(...extractedTimes);
                    }
                } catch (error) {
                    console.log(`❌ Error clicking on time slot: ${error.message}`);
                }
            }

            return allAvailableTimes;
        };

        const processMonth = async () => {
            while (monthCount < 2) {
                console.log(`📅 Checking month ${monthCount + 1} for available dates...`);
                let availableDates = await extractAvailableDates();
                console.log(`✅ Available Dates: ${availableDates.length > 0 ? availableDates.join(", ") : "None"}`);

                for (const dateId of availableDates) {
                    console.log(`🖱 Clicking on available date: ${dateId}...`);

                    let buttonSelector = `.CalendarDay_button[data-date-id="${dateId}"]`;
                    let button = await page.$(buttonSelector);
                    if (button) {
                        console.log(`✅ Found date button: ${dateId}, clicking...`);
                        await button.click();
                        await new Promise(resolve => setTimeout(resolve, 2000));

                        let availableTimes = await clickEventTimesAndExtract(dateId);
                        results.push({ date: dateId, times: availableTimes });

                        await clickCanviarButton();
                    } else {
                        console.log(`❌ Button for ${dateId} not found.`);
                    }
                }

                if (monthCount < 1) {
                    console.log("➡️ Moving to next month...");
                    const nextMonthButton = await page.$('div[role="button"][aria-label="Move forward to switch to the next month."]');
                    if (nextMonthButton) {
                        await nextMonthButton.click();
                        await new Promise(resolve => setTimeout(resolve, 4000));
                        monthCount++;
                    } else {
                        console.log("❌ 'Next Month' button not found. Ending process.");
                        break;
                    }
                } else {
                    break;
                }
            }
        };

        console.log("🔄 Starting month processing...");
        await processMonth();
        console.log("✅ Finished processing months.");

        await browser.close();
        console.log("🛑 Browser closed.");

        // Save to Cloud Storage
        const fileName = `scraped_data_${Date.now()}.json`;
        const file = storage.bucket(bucketName).file(fileName);
        await file.save(JSON.stringify(results, null, 2));
        console.log(`✅ Data saved to Cloud Storage: ${fileName}`);

        // Generate public URL (Optional)
        const publicUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;

        // Send response immediately
        res.status(202).json({ success: true, message: "Data processing started", dataUrl: publicUrl });

    } catch (error) {
        console.error("❌ An error occurred:", error);
        res.status(500).json({ success: false, error: error.message });
    }
};
