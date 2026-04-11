require('dotenv').config();
const express = require("express");
const path = require("path");
const tempmailRouter = require("./routes/tempmail.js");

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Main TempMail API Route
app.use("/api/tempmail", tempmailRouter);

// Frontend route
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Error handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: "Something went wrong on the server" });
});

app.listen(PORT, () => {
    console.log(`TempMail server connected at http://localhost:${PORT}`);
});
