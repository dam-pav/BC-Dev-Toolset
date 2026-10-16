tableextension 50203 "BCD Probe Metadata Extension" extends Currency
{
    fields
    {
        field(50203; "BCD Extension Text"; Text[100]) { DataClassification = CustomerContent; }
        field(50204; "BCD Extension Choice"; Enum "Sales Line Type") { DataClassification = CustomerContent; }
    }
}
