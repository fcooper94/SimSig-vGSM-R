# speech-recognize.ps1
# Uses Windows built-in Speech Recognition with a constrained grammar
# for much better accuracy on known railway phrases.
# Usage: powershell -File speech-recognize.ps1 [-TimeoutSeconds 5]

param(
    [int]$TimeoutSeconds = 5
)

Add-Type -AssemblyName System.Speech

try {
    # Try en-GB for British railway terminology, fall back to system default
    try {
        $culture = New-Object System.Globalization.CultureInfo("en-GB")
        $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
    } catch {
        $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
    }

    # Build a grammar with specific railway reply phrases (much more accurate than dictation)
    $choices = New-Object System.Speech.Recognition.Choices
    $choices.Add("wait 2 minutes")
    $choices.Add("wait two minutes")
    $choices.Add("2 minutes")
    $choices.Add("two minutes")
    $choices.Add("wait 5 minutes")
    $choices.Add("wait five minutes")
    $choices.Add("5 minutes")
    $choices.Add("five minutes")
    $choices.Add("please 5 minutes")
    $choices.Add("wait 15 minutes")
    $choices.Add("wait fifteen minutes")
    $choices.Add("15 minutes")
    $choices.Add("fifteen minutes")
    $choices.Add("pass at danger")
    $choices.Add("pass signal at danger")
    $choices.Add("pass at stop")
    $choices.Add("authorise pass")
    $choices.Add("authorise driver to pass")
    $choices.Add("pass signal")
    $choices.Add("examine the line")
    $choices.Add("examine line")
    $choices.Add("pass and examine")
    $choices.Add("pass signal at stop and examine")
    $choices.Add("ok")
    $choices.Add("okay")

    $builder = New-Object System.Speech.Recognition.GrammarBuilder
    $builder.Append($choices)

    $grammar = New-Object System.Speech.Recognition.Grammar($builder)
    $engine.LoadGrammar($grammar)

    # Also load dictation as fallback (lower priority)
    $dictation = New-Object System.Speech.Recognition.DictationGrammar
    $dictation.Weight = 0.1
    $engine.LoadGrammar($dictation)

    $engine.SetInputToDefaultAudioDevice()

    # Speed up end-of-speech detection
    $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(500)
    $engine.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(300)

    $result = $engine.Recognize([TimeSpan]::FromSeconds($TimeoutSeconds))
    $engine.Dispose()

    if ($result -and $result.Text) {
        $text = $result.Text -replace '\\', '\\\\' -replace '"', '\"'
        $confidence = [math]::Round($result.Confidence, 2)
        Write-Output "{`"text`":`"$text`",`"confidence`":$confidence}"
    } else {
        Write-Output '{"text":""}'
    }
} catch {
    $msg = $_.Exception.Message -replace '\\', '\\\\' -replace '"', '\"'
    Write-Output "{`"error`":`"$msg`"}"
}
